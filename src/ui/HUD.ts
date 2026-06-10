import type { Renderer } from "../engine/Renderer";
import type { Match } from "../game/Match";
import type { TeamConfig } from "../game/Team";
import { LEFT_GOAL_X, RIGHT_GOAL_X } from "../game/Field";
import { drawCrest } from "./Emblems";
import { COLORS, FONT } from "./Theme";

/** Top scoreboard: score, quarter, clock, down & distance, possession, field bar. */
export class HUD {
  // Score-change flourish: remember each side's score and stamp the moment it changes so the
  // chip can pop + glow for a beat afterward.
  private homeScorePrev = -1;
  private awayScorePrev = -1;
  private homeFlashAt = -1e9;
  private awayFlashAt = -1e9;

  /** 1 just after a score, easing to 0 over ~0.9s. */
  private flashAmt(at: number): number {
    const e = (performance.now() - at) / 900;
    return e >= 1 || e < 0 ? 0 : 1 - e;
  }

  render(
    r: Renderer,
    match: Match,
    opts: { turbo: number; fire?: { meter: number; onFire: boolean }; possessionLabel?: string; playClock?: number; minimal?: boolean },
  ): void {
    const ctx = r.ctx;
    const w = r.width;
    // During live play the HUD is stripped to a minimal score/clock bug + turbo, so the field
    // stays uncluttered; the full board (down & distance, field bar) shows between plays.
    const minimal = !!opts.minimal;
    const barH = minimal ? 40 : 46;

    const g = ctx.createLinearGradient(0, 0, 0, barH);
    g.addColorStop(0, "rgba(16,15,20,0.94)");
    g.addColorStop(1, "rgba(8,8,10,0.9)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, barH);
    ctx.fillStyle = COLORS.blood;
    ctx.fillRect(0, barH - 3, w, 3);

    const home = match.home;
    const away = match.away;
    // Detect a score change and stamp it (skip the first frame, when prev is uninitialized).
    if (home.score !== this.homeScorePrev) { if (this.homeScorePrev >= 0) this.homeFlashAt = performance.now(); this.homeScorePrev = home.score; }
    if (away.score !== this.awayScorePrev) { if (this.awayScorePrev >= 0) this.awayFlashAt = performance.now(); this.awayScorePrev = away.score; }
    this.teamChip(r, 10, 6, home.config, home.score, home.onFire, "left", match.possession === "HOME", this.flashAmt(this.homeFlashAt));
    this.teamChip(r, w - 10, 6, away.config, away.score, away.onFire, "right", match.possession === "AWAY", this.flashAmt(this.awayFlashAt));

    const mins = Math.floor(match.clock / 60);
    const secs = Math.floor(match.clock % 60);
    r.text(`Q${match.quarter}`, w / 2, minimal ? 5 : 7, { size: 12, align: "center", color: COLORS.blood, baseline: "top", font: FONT.display });
    r.text(`${mins}:${secs.toString().padStart(2, "0")}`, w / 2, minimal ? 16 : 20, { size: minimal ? 20 : 22, align: "center", color: COLORS.bone, baseline: "top", font: FONT.display });

    // The full board (down & distance, field-position bar) only shows between plays — during
    // the snap it'd clutter the action, so it's hidden in minimal mode.
    if (!minimal) {
      const dd = match.isGoalToGo() ? `${ordinal(match.down)} & GOAL` : `${ordinal(match.down)} & ${match.distanceYards}`;
      const possName = match.team(match.possession).config.abbr;
      r.text(`${possName}  ${dd}  ·  ${match.fieldSideLabel()}`.toUpperCase(), w / 2, barH + 7, {
        size: 13,
        align: "center",
        color: COLORS.ash,
        baseline: "top",
        font: FONT.ui,
      });
      this.fieldBar(r, match, barH + 24);
    }

    if (opts.possessionLabel && !minimal) {
      r.text(opts.possessionLabel, w / 2, barH + 48, { size: 12, align: "center", color: COLORS.hazard, baseline: "top", font: FONT.ui });
    }
    if (opts.playClock !== undefined) {
      r.text(`:${Math.ceil(opts.playClock).toString().padStart(2, "0")}`, w / 2 + 64, 20, {
        size: 16,
        align: "left",
        color: opts.playClock < 1 ? COLORS.bloodBright : COLORS.steel,
        baseline: "top",
        font: FONT.display,
      });
    }

    this.turboMeter(r, opts.turbo);
    if (opts.fire) this.fireMeter(r, opts.fire.meter, opts.fire.onFire);
  }

  /** A compact field showing the ball spot and first-down line for orientation. */
  private fieldBar(r: Renderer, match: Match, y: number): void {
    const ctx = r.ctx;
    const bw = Math.min(360, r.width * 0.5);
    const x = (r.width - bw) / 2;
    const h = 9;
    const span = RIGHT_GOAL_X - LEFT_GOAL_X;
    const frac = (wx: number) => (Math.max(LEFT_GOAL_X, Math.min(RIGHT_GOAL_X, wx)) - LEFT_GOAL_X) / span;

    // Field + end-zone caps (left = HOME's own goal, right = HOME's target).
    ctx.fillStyle = "#0f5a2a";
    ctx.fillRect(x, y, bw, h);
    ctx.fillStyle = "#0e6b8f";
    ctx.fillRect(x - 7, y, 7, h);
    ctx.fillStyle = "#b03a3a";
    ctx.fillRect(x + bw, y, 7, h);
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 7, y, bw + 14, h);

    // First-down line (yellow) + ball spot (white).
    const fdx = x + frac(match.firstDownX) * bw;
    ctx.fillStyle = "#ffd23a";
    ctx.fillRect(fdx - 1, y - 2, 2, h + 4);
    const bx = x + frac(match.losX) * bw;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(bx, y - 3);
    ctx.lineTo(bx - 4, y - 8);
    ctx.lineTo(bx + 4, y - 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(bx - 1, y - 3, 2, h + 3);

    // Possession direction arrow.
    const dir = match.attackDir(match.possession);
    ctx.fillStyle = match.team(match.possession).config.colors.jersey;
    const ay = y + h + 7;
    ctx.beginPath();
    ctx.moveTo(bx + dir * 7, ay);
    ctx.lineTo(bx, ay - 4);
    ctx.lineTo(bx, ay + 4);
    ctx.closePath();
    ctx.fill();
  }

  private teamChip(
    r: Renderer,
    x: number,
    y: number,
    team: TeamConfig,
    score: number,
    onFire: boolean,
    align: "left" | "right",
    hasBall: boolean,
    flash = 0,
  ): void {
    const ctx = r.ctx;
    ctx.save();
    const cR = 16;
    const crestX = align === "left" ? x + cR : x - cR;
    const crestY = y + cR + 1;
    // Score flourish: an expanding ring bursts out from the crest as the number pops.
    if (flash > 0) {
      ctx.save();
      ctx.strokeStyle = team.colors.accent;
      ctx.globalAlpha = flash;
      ctx.lineWidth = 2 + flash * 2;
      ctx.beginPath();
      ctx.arc(crestX, crestY, cR + 4 + (1 - flash) * 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (onFire) {
      ctx.strokeStyle = "#ff7b1e";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(crestX, crestY, cR + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawCrest(ctx, crestX, crestY, cR, team);

    const textX = align === "left" ? x + cR * 2 + 8 : x - cR * 2 - 8;
    const tAlign: CanvasTextAlign = align === "left" ? "left" : "right";
    // The number pops up in size and flashes to the team accent, then settles back to bone white.
    const ease = flash * flash;
    const size = 26 + 16 * ease;
    const color = flash > 0.02 ? mixHex(COLORS.bone, team.colors.accent, ease) : COLORS.bone;
    ctx.save();
    if (flash > 0.02) { ctx.shadowColor = team.colors.accent; ctx.shadowBlur = 18 * ease; }
    r.text(String(score), textX, y + 4 - 8 * ease, { size, color, align: tAlign, baseline: "top", font: FONT.display });
    ctx.restore();

    if (hasBall) {
      const sw = r.measureText(String(score), 24);
      const fx = align === "left" ? textX + sw + 11 : textX - sw - 11;
      ctx.fillStyle = "#8a4b22";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(fx, y + 20, 7, 4.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private turboMeter(r: Renderer, turbo: number): void {
    const ctx = r.ctx;
    const w = 120;
    const h = 12;
    const x = 16;
    const y = r.height - 26;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = COLORS.bg1;
    ctx.fillRect(x, y, w, h);
    const fill = Math.max(0, Math.min(1, turbo));
    ctx.fillStyle = fill > 0.25 ? COLORS.hazard : COLORS.bloodBright;
    ctx.fillRect(x, y, w * fill, h);
    ctx.strokeStyle = "rgba(123,134,148,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    r.text("TURBO", x, y - 14, { size: 11, color: COLORS.ash, baseline: "top", font: FONT.ui });
  }

  /** The ON FIRE build-up meter, sitting just above the turbo bar; pulses + glows when lit. */
  private fireMeter(r: Renderer, meter: number, onFire: boolean): void {
    const ctx = r.ctx;
    const w = 120;
    const h = 10;
    const x = 16;
    const y = r.height - 52;
    const fill = Math.max(0, Math.min(1, meter));
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = COLORS.bg1;
    ctx.fillRect(x, y, w, h);
    const pulse = onFire ? 0.7 + 0.3 * Math.sin(performance.now() / 110) : 1;
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, "#ffd23a");
    grad.addColorStop(0.6, "#ff8a1e");
    grad.addColorStop(1, "#ff3a1e");
    if (onFire) { ctx.shadowColor = "#ff7b1e"; ctx.shadowBlur = 10; }
    ctx.globalAlpha = pulse;
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w * fill, h);
    ctx.restore();
    ctx.strokeStyle = onFire ? "#ffb04a" : "rgba(123,134,148,0.5)";
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    r.text(onFire ? "ON FIRE!" : "FIRE", x, y - 13, { size: 11, color: onFire ? "#ff9a3a" : COLORS.ash, baseline: "top", font: FONT.ui });
  }
}

function ordinal(n: number): string {
  return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`;
}

/** Lerp between two #rrggbb colors by t (0..1), returned as #rrggbb. */
function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const k = Math.max(0, Math.min(1, t));
  const ch = (sh: number) => {
    const ca = (pa >> sh) & 0xff, cb = (pb >> sh) & 0xff;
    return Math.round(ca + (cb - ca) * k);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}
