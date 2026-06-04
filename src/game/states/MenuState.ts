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
    this.layout();
    const cx = r.width / 2;

    // Animated title.
    const bob = Math.sin(this.t * 2) * 4;
    r.text("GRIDIRON", cx, r.height * 0.16 + bob, { size: 44, align: "center", color: "#ffd23a" });
    r.text("BLITZ", cx, r.height * 0.16 + 44 + bob, { size: 52, align: "center", color: "#ff7b1e" });
    r.text("arcade football", cx, r.height * 0.16 + 84 + bob, {
      size: 14,
      align: "center",
      color: "#9fd9b0",
      weight: "normal",
    });

    const c = this.app.config;
    const home = TEAMS[c.homeTeamIndex % TEAMS.length];
    const away = TEAMS[c.awayTeamIndex % TEAMS.length];

    this.teamRow(r, this.rects.teamPrev, this.rects.teamNext, "YOU", home.name, home.colors.jersey);
    this.teamRow(r, this.rects.oppPrev, this.rects.oppNext, "VS", away.name, away.colors.jersey);

    drawButton(r, this.rects.diff, `DIFFICULTY: ${c.difficulty.toUpperCase()}`, { fill: "#175a30", size: 16 });
    drawButton(r, this.rects.mute, c.muted ? "SOUND: OFF" : "SOUND: ON", { fill: "#244", size: 14 });
    drawButton(r, this.rects.play, "KICK OFF!", { fill: "#d03a3a", size: 26 });

    // Top high score.
    if (this.app.highScores.length > 0) {
      const hs = this.app.highScores[0];
      r.text(`BEST: ${hs.team} ${hs.points}–${hs.opponentPoints} ${hs.opponent}`, cx, r.height - 12, {
        size: 12,
        align: "center",
        color: "rgba(255,255,255,0.6)",
        weight: "normal",
        baseline: "bottom",
      });
    }
  }

  private teamRow(
    r: GameApp["r"],
    prev: Rect,
    next: Rect,
    label: string,
    name: string,
    color: string,
  ): void {
    const cx = r.width / 2;
    drawButton(r, prev, "<", { fill: "#234", size: 22 });
    drawButton(r, next, ">", { fill: "#234", size: 22 });
    const ctx = r.ctx;
    ctx.fillStyle = color;
    ctx.fillRect(prev.x + prev.w + 10, prev.y + 6, 26, 26);
    r.text(label, cx, prev.y - 2, { size: 11, align: "center", color: "#9fd9b0", baseline: "bottom", weight: "normal" });
    r.text(name, cx + 16, prev.y + prev.h / 2, { size: 20, align: "center", color: "#fff", baseline: "middle" });
  }
}

function wrap(i: number): number {
  return ((i % TEAMS.length) + TEAMS.length) % TEAMS.length;
}
