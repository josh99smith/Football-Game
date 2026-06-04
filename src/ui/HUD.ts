import type { Renderer } from "../engine/Renderer";
import type { Match } from "../game/Match";
import type { TeamConfig } from "../game/Team";
import { LEFT_GOAL_X, RIGHT_GOAL_X } from "../game/Field";
import { drawCrest } from "./Emblems";

/** Top scoreboard: score, quarter, clock, down & distance, possession, field bar. */
export class HUD {
  render(
    r: Renderer,
    match: Match,
    opts: { turbo: number; possessionLabel?: string; playClock?: number },
  ): void {
    const ctx = r.ctx;
    const w = r.width;
    const barH = 46;

    ctx.fillStyle = "rgba(8, 20, 12, 0.86)";
    ctx.fillRect(0, 0, w, barH);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(0, barH - 2, w, 2);

    const home = match.home;
    const away = match.away;
    this.teamChip(r, 10, 6, home.config, home.score, home.onFire, "left", match.possession === "HOME");
    this.teamChip(r, w - 10, 6, away.config, away.score, away.onFire, "right", match.possession === "AWAY");

    const mins = Math.floor(match.clock / 60);
    const secs = Math.floor(match.clock % 60);
    r.text(`Q${match.quarter}`, w / 2, 8, { size: 13, align: "center", color: "#ffd23a", baseline: "top" });
    r.text(`${mins}:${secs.toString().padStart(2, "0")}`, w / 2, 22, { size: 20, align: "center", color: "#fff", baseline: "top" });

    // Down & distance.
    const dd = match.isGoalToGo() ? `${ordinal(match.down)} & GOAL` : `${ordinal(match.down)} & ${match.distanceYards}`;
    const possName = match.team(match.possession).config.abbr;
    r.text(`${possName}  ${dd}  ·  ${match.fieldSideLabel()}`, w / 2, barH + 6, {
      size: 13,
      align: "center",
      color: "#dfeee2",
      baseline: "top",
    });

    this.fieldBar(r, match, barH + 24);

    if (opts.possessionLabel) {
      r.text(opts.possessionLabel, w / 2, barH + 48, { size: 12, align: "center", color: "#ffd23a", baseline: "top" });
    }
    if (opts.playClock !== undefined) {
      r.text(`:${Math.ceil(opts.playClock).toString().padStart(2, "0")}`, w / 2 + 64, 22, {
        size: 16,
        align: "left",
        color: opts.playClock < 1 ? "#ff6a6a" : "#9fd9b0",
        baseline: "top",
      });
    }

    this.turboMeter(r, opts.turbo);
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
  ): void {
    const ctx = r.ctx;
    ctx.save();
    const cR = 16;
    const crestX = align === "left" ? x + cR : x - cR;
    const crestY = y + cR + 1;
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
    r.text(String(score), textX, y + 7, { size: 24, color: "#fff", align: tAlign, baseline: "top" });

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
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    ctx.fillStyle = "#0a3a1a";
    ctx.fillRect(x, y, w, h);
    const fill = Math.max(0, Math.min(1, turbo));
    ctx.fillStyle = fill > 0.25 ? "#28c0ff" : "#ff5a5a";
    ctx.fillRect(x, y, w * fill, h);
    r.text("TURBO", x, y - 14, { size: 11, color: "#bfe", baseline: "top" });
  }
}

function ordinal(n: number): string {
  return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`;
}
