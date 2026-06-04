import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { TEAMS } from "../Team";
import { drawButton, tappedIn, type Rect } from "../../ui/widgets";
import { drawCrest, drawGameBadge } from "../../ui/Emblems";
import { saveSettings, loadSettings } from "../storage";
import { KickoffState } from "./KickoffState";

const DIFFS: GameApp["config"]["difficulty"][] = ["rookie", "pro", "allpro"];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Title screen: pick your team, opponent, difficulty, then kick off. */
export class MenuState implements GameState {
  private readonly app: GameApp;
  private rects: Record<string, Rect> = {};
  private t = 0;

  // Layout values shared between layout() and render().
  private crestR = 40;
  private teamY = 0;
  private cxL = 0;
  private cxR = 0;
  private titleY = 0;
  private badgeR = 24;

  constructor(app: GameApp) {
    this.app = app;
    const s = loadSettings();
    if (s.difficulty) app.config.difficulty = s.difficulty;
    if (typeof s.muted === "boolean") app.config.muted = s.muted;
    if (typeof s.homeTeamIndex === "number") app.config.homeTeamIndex = s.homeTeamIndex;
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.layout();
    this.app.audio.setMuted(this.app.config.muted);
  }

  /**
   * Fully responsive, computed bottom-up so nothing ever overlaps — the previous
   * fixed-pixel layout collapsed the PLAY button onto the SOUND button in short
   * landscape viewports, which is why the start button "barely worked".
   */
  private layout(): void {
    const r = this.app.r;
    const W = r.width;
    const H = r.height;
    const cx = W / 2;

    const margin = clamp(H * 0.05, 12, 34);
    const playH = clamp(H * 0.13, 46, 66);
    const playY = H - playH - margin;
    const playW = clamp(W * 0.5, 200, 360);

    const optH = clamp(H * 0.085, 30, 44);
    const optY = playY - optH - clamp(H * 0.04, 10, 22);
    const optW = clamp(W * 0.3, 140, 240);

    this.crestR = clamp(Math.min(H * 0.13, W * 0.085), 22, 54);
    const aw = clamp(Math.min(H * 0.1, W * 0.07), 28, 44);
    const gap = 8;
    this.cxL = W * 0.28;
    this.cxR = W * 0.72;
    this.teamY = optY - optH * 0.3 - 22 - this.crestR;
    this.badgeR = clamp(Math.min(H * 0.07, W * 0.06), 16, 30);
    this.titleY = clamp(this.teamY - this.crestR - 64, this.badgeR * 2 + 10, H * 0.3);

    const arrow = (centre: number, side: number): Rect => ({
      x: side < 0 ? centre - this.crestR - gap - aw : centre + this.crestR + gap,
      y: this.teamY - aw / 2,
      w: aw,
      h: aw,
    });

    this.rects = {
      teamPrev: arrow(this.cxL, -1),
      teamNext: arrow(this.cxL, 1),
      oppPrev: arrow(this.cxR, -1),
      oppNext: arrow(this.cxR, 1),
      diff: { x: cx - optW - 6, y: optY, w: optW, h: optH },
      mute: { x: cx + 6, y: optY, w: optW, h: optH },
      play: { x: cx - playW / 2, y: playY, w: playW, h: playH },
    };
  }

  update(dt: number): void {
    this.t += dt;
    const taps = this.app.input.consumeTaps();
    if (taps.length === 0) return;
    this.app.audio.resume();
    const c = this.app.config;

    if (tappedIn(this.rects.teamPrev, taps)) c.homeTeamIndex = wrap(c.homeTeamIndex - 1);
    else if (tappedIn(this.rects.teamNext, taps)) c.homeTeamIndex = wrap(c.homeTeamIndex + 1);
    else if (tappedIn(this.rects.oppPrev, taps)) c.awayTeamIndex = wrap(c.awayTeamIndex - 1);
    else if (tappedIn(this.rects.oppNext, taps)) c.awayTeamIndex = wrap(c.awayTeamIndex + 1);
    else if (tappedIn(this.rects.diff, taps)) {
      c.difficulty = DIFFS[(DIFFS.indexOf(c.difficulty) + 1) % DIFFS.length];
    } else if (tappedIn(this.rects.mute, taps)) {
      c.muted = !c.muted;
      this.app.audio.setMuted(c.muted);
    } else if (tappedIn(this.rects.play, taps)) {
      this.startGame();
      return;
    } else {
      this.app.audio.uiTap();
      return;
    }
    if (c.awayTeamIndex === c.homeTeamIndex) c.awayTeamIndex = wrap(c.awayTeamIndex + 1);
    this.app.audio.uiTap();
    saveSettings({ difficulty: c.difficulty, muted: c.muted, homeTeamIndex: c.homeTeamIndex });
  }

  private startGame(): void {
    this.app.audio.uiConfirm();
    this.app.newMatch();
    this.app.setState(new KickoffState(this.app, "HOME"));
  }

  render(): void {
    const r = this.app.r;
    const W = r.width;
    this.app.r.begin("#06210e");
    this.drawBackground(r);
    this.layout();
    const cx = W / 2;
    const ctx = r.ctx;

    // Badge + glowing wordmark on a single line (compact for landscape).
    drawGameBadge(ctx, cx, this.titleY - this.badgeR * 0.2, this.badgeR);
    const titleSize = clamp(Math.min(W * 0.075, this.crestR * 1.1), 22, 46);
    const wordY = this.titleY + this.badgeR + titleSize * 0.5;
    ctx.save();
    ctx.shadowColor = "rgba(255,140,30,0.6)";
    ctx.shadowBlur = 22;
    r.text("GRIDIRON ", cx, wordY, { size: titleSize, align: "right", color: "#ffd23a", baseline: "middle" });
    r.text(" BLITZ", cx, wordY, { size: titleSize, align: "left", color: "#ff7b1e", baseline: "middle" });
    ctx.restore();

    if (this.app.highScores.length > 0) {
      const hs = this.app.highScores[0];
      r.text(`BEST: ${hs.team} ${hs.points}–${hs.opponentPoints} ${hs.opponent}`, cx, wordY + titleSize * 0.7, {
        size: 11,
        align: "center",
        color: "rgba(200,230,210,0.7)",
        weight: "normal",
        baseline: "middle",
      });
    }

    const c = this.app.config;
    const home = TEAMS[c.homeTeamIndex % TEAMS.length];
    const away = TEAMS[c.awayTeamIndex % TEAMS.length];
    this.teamColumn(r, this.cxL, "YOU", home, this.rects.teamPrev, this.rects.teamNext);
    this.teamColumn(r, this.cxR, "OPPONENT", away, this.rects.oppPrev, this.rects.oppNext);

    drawButton(r, this.rects.diff, `DIFF: ${c.difficulty.toUpperCase()}`, { fill: "#175a30", size: 15 });
    drawButton(r, this.rects.mute, c.muted ? "SOUND: OFF" : "SOUND: ON", { fill: "#244", size: 14 });
    drawButton(r, this.rects.play, "KICK OFF!", { fill: "#d03a3a", size: clamp(this.rects.play.h * 0.42, 20, 30) });
  }

  private teamColumn(r: GameApp["r"], cx: number, label: string, team: (typeof TEAMS)[number], prev: Rect, next: Rect): void {
    r.text(label, cx, this.teamY - this.crestR - 8, { size: 12, align: "center", color: "#9fd9b0", baseline: "bottom", weight: "normal" });
    drawCrest(r.ctx, cx, this.teamY, this.crestR, team);
    drawButton(r, prev, "‹", { fill: "#21384a", size: 24 });
    drawButton(r, next, "›", { fill: "#21384a", size: 24 });
    r.text(team.name, cx, this.teamY + this.crestR + 16, { size: clamp(this.crestR * 0.42, 13, 19), align: "center", color: "#fff", baseline: "middle" });
  }

  /** Subtle animated gridiron backdrop (scrolling yard lines + a sweeping glow). */
  private drawBackground(r: GameApp["r"]): void {
    const ctx = r.ctx;
    const grad = ctx.createLinearGradient(0, 0, 0, r.height);
    grad.addColorStop(0, "#082713");
    grad.addColorStop(1, "#04160a");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, r.width, r.height);

    const spacing = 64;
    const off = (this.t * 26) % spacing;
    ctx.strokeStyle = "rgba(255,255,255,0.045)";
    ctx.lineWidth = 2;
    for (let x = -spacing; x < r.width + spacing; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x + off, 0);
      ctx.lineTo(x + off, r.height);
      ctx.stroke();
    }
    const bx = ((this.t * 90) % (r.width + 300)) - 150;
    const g2 = ctx.createLinearGradient(bx - 120, 0, bx + 120, 0);
    g2.addColorStop(0, "rgba(255,210,60,0)");
    g2.addColorStop(0.5, "rgba(255,210,60,0.05)");
    g2.addColorStop(1, "rgba(255,210,60,0)");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, r.width, r.height);
  }
}

function wrap(i: number): number {
  return ((i % TEAMS.length) + TEAMS.length) % TEAMS.length;
}
