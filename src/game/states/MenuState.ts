import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { TEAMS } from "../Team";
import { drawButton, tappedIn, type Rect } from "../../ui/widgets";
import { saveSettings, loadSettings } from "../storage";
import { KickoffState } from "./KickoffState";

const DIFFS: GameApp["config"]["difficulty"][] = ["rookie", "pro", "allpro"];

/** Title screen: pick your team, opponent, difficulty, then kick off. */
export class MenuState implements GameState {
  private readonly app: GameApp;
  private rects: Record<string, Rect> = {};
  private t = 0;

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

  private layout(): void {
    const r = this.app.r;
    const cx = r.width / 2;
    const bw = Math.min(260, r.width * 0.6);
    const rowY = r.height * 0.42;
    this.rects = {
      teamPrev: { x: cx - bw / 2 - 44, y: rowY, w: 38, h: 38 },
      teamNext: { x: cx + bw / 2 + 6, y: rowY, w: 38, h: 38 },
      oppPrev: { x: cx - bw / 2 - 44, y: rowY + 56, w: 38, h: 38 },
      oppNext: { x: cx + bw / 2 + 6, y: rowY + 56, w: 38, h: 38 },
      diff: { x: cx - bw / 2, y: rowY + 112, w: bw, h: 40 },
      mute: { x: cx - bw / 2, y: rowY + 160, w: bw, h: 36 },
      play: { x: cx - bw / 2, y: r.height - 80, w: bw, h: 56 },
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
    // Coin toss: the human team receives first.
    this.app.setState(new KickoffState(this.app, "HOME"));
  }

  render(): void {
    const r = this.app.r;
    this.app.r.begin("#06210e");
    this.drawBackground(r);
    this.layout();
    const cx = r.width / 2;

    // Animated, glowing title.
    const bob = Math.sin(this.t * 2) * 4;
    const ctx = r.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(255,140,30,0.6)";
    ctx.shadowBlur = 24;
    r.text("GRIDIRON", cx, r.height * 0.15 + bob, { size: 46, align: "center", color: "#ffd23a" });
    r.text("BLITZ", cx, r.height * 0.15 + 48 + bob, { size: 56, align: "center", color: "#ff7b1e" });
    ctx.restore();
    r.text("· ARCADE FOOTBALL ·", cx, r.height * 0.15 + 90 + bob, {
      size: 13,
      align: "center",
      color: "#9fd9b0",
      weight: "normal",
    });

    const c = this.app.config;
    const home = TEAMS[c.homeTeamIndex % TEAMS.length];
    const away = TEAMS[c.awayTeamIndex % TEAMS.length];

    this.teamRow(r, this.rects.teamPrev, this.rects.teamNext, "YOU", home);
    this.teamRow(r, this.rects.oppPrev, this.rects.oppNext, "VS", away);

    drawButton(r, this.rects.diff, `DIFFICULTY: ${c.difficulty.toUpperCase()}`, { fill: "#175a30", size: 16 });
    drawButton(r, this.rects.mute, c.muted ? "SOUND: OFF" : "SOUND: ON", { fill: "#244", size: 14 });
    drawButton(r, this.rects.play, "KICK OFF!", { fill: "#d03a3a", size: 26 });

    // Controls hint.
    r.text("MOVE: stick / WASD   ·   TURBO   ·   PASS / SWITCH", cx, r.height - 30, {
      size: 11,
      align: "center",
      color: "rgba(180,220,190,0.75)",
      weight: "normal",
      baseline: "bottom",
    });
    if (this.app.highScores.length > 0) {
      const hs = this.app.highScores[0];
      r.text(`BEST: ${hs.team} ${hs.points}–${hs.opponentPoints} ${hs.opponent}`, cx, r.height - 12, {
        size: 12,
        align: "center",
        color: "rgba(255,255,255,0.55)",
        weight: "normal",
        baseline: "bottom",
      });
    }
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
    // Sweeping highlight band.
    const bx = ((this.t * 90) % (r.width + 300)) - 150;
    const g2 = ctx.createLinearGradient(bx - 120, 0, bx + 120, 0);
    g2.addColorStop(0, "rgba(255,210,60,0)");
    g2.addColorStop(0.5, "rgba(255,210,60,0.05)");
    g2.addColorStop(1, "rgba(255,210,60,0)");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, r.width, r.height);
  }

  private teamRow(r: GameApp["r"], prev: Rect, next: Rect, label: string, team: (typeof TEAMS)[number]): void {
    const cx = r.width / 2;
    drawButton(r, prev, "‹", { fill: "#234", size: 24 });
    drawButton(r, next, "›", { fill: "#234", size: 24 });
    drawHelmet(r, prev.x + prev.w + 22, prev.y + prev.h / 2, 15, team.colors.jersey, team.colors.trim);
    r.text(label, cx, prev.y - 2, { size: 11, align: "center", color: "#9fd9b0", baseline: "bottom", weight: "normal" });
    r.text(team.name, cx + 22, prev.y + prev.h / 2, { size: 20, align: "center", color: "#fff", baseline: "middle" });
  }
}

/** A small team helmet icon (dome + facemask) for menus. */
function drawHelmet(r: GameApp["r"], x: number, y: number, rad: number, jersey: string, trim: string): void {
  const ctx = r.ctx;
  ctx.save();
  ctx.fillStyle = jersey;
  ctx.beginPath();
  ctx.arc(x, y, rad, Math.PI * 0.9, Math.PI * 2.1);
  ctx.fill();
  // Facemask.
  ctx.strokeStyle = trim;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x + rad * 0.5, y + rad * 0.2);
  ctx.lineTo(x + rad * 1.05, y + rad * 0.2);
  ctx.stroke();
  // Stripe.
  ctx.strokeStyle = trim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, rad * 0.55, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
  ctx.restore();
}

function wrap(i: number): number {
  return ((i % TEAMS.length) + TEAMS.length) % TEAMS.length;
}
