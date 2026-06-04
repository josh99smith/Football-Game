import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { Renderer } from "../../engine/Renderer";
import { HUD } from "../../ui/HUD";
import { drawPanel, tappedIn, type Rect } from "../../ui/widgets";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import {
  OFFENSE_PLAYS,
  DEFENSE_PLAYS,
  type OffensePlay,
  type DefensePlay,
} from "../Playbook";
import { cpuOffensePlay, cpuDefensePlay } from "../ai/PlayCaller";
import { LivePlayState } from "./LivePlayState";

/**
 * Quick card-pick play call. The human picks for whichever side they're on (offense
 * if they have the ball, otherwise defense); the CPU's opposing call is random.
 * Designed for minimal downtime — one tap and you're back in the action.
 */
export class PlaySelectState implements GameState {
  private readonly app: GameApp;
  private readonly humanOffense: boolean;
  private hud = new HUD();
  private cards: { rect: Rect; off?: OffensePlay; def?: DefensePlay }[] = [];

  constructor(app: GameApp) {
    this.app = app;
    this.humanOffense = app.match.possession === app.match.humanTeam;
  }

  enter(): void {
    this.app.input.consumeTaps(); // clear stale taps from the prior screen
    this.layout();
  }

  private layout(): void {
    const r = this.app.r;
    const plays = this.humanOffense ? OFFENSE_PLAYS : DEFENSE_PLAYS;
    const n = plays.length;
    const cols = Math.min(n, 4);
    const gap = 14;
    const cardW = Math.min(180, (r.width - 40 - gap * (cols - 1)) / cols);
    const cardH = Math.min(150, r.height * 0.4);
    const totalW = cols * cardW + (cols - 1) * gap;
    const startX = (r.width - totalW) / 2;
    const y = r.height / 2 - cardH / 2 + 20;

    this.cards = plays.map((p, i) => {
      const rect: Rect = { x: startX + i * (cardW + gap), y, w: cardW, h: cardH };
      return this.humanOffense
        ? { rect, off: p as OffensePlay }
        : { rect, def: p as DefensePlay };
    });
  }

  update(): void {
    const taps = this.app.input.consumeTaps();
    if (taps.length === 0) return;
    for (const card of this.cards) {
      if (tappedIn(card.rect, taps)) {
        this.app.audio.resume();
        this.app.audio.uiConfirm();
        this.choose(card.off, card.def);
        return;
      }
    }
  }

  private choose(off?: OffensePlay, def?: DefensePlay): void {
    // The human picks for their side; the CPU calls the opposing play situationally.
    const offensePlay = off ?? cpuOffensePlay(this.app.match);
    const defensePlay = def ?? cpuDefensePlay(this.app.match);
    this.app.setState(new LivePlayState(this.app, offensePlay, defensePlay));
  }

  render(): void {
    const r = this.app.r;
    this.app.r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, performance.now() / 1000);
    this.hud.render(r, this.app.match, { turbo: 1 });

    const title = this.humanOffense ? "CALL IT — OFFENSE" : "CALL IT — DEFENSE";
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "2px";
    r.text(title, r.width / 2, r.height / 2 - r.height * 0.24, {
      size: 26,
      align: "center",
      color: COLORS.bone,
      font: FONT.display,
    });
    ctx.restore();

    for (const card of this.cards) {
      const name = card.off?.name ?? card.def?.name ?? "";
      drawPanel(r, card.rect, COLORS.panel);
      r.text(name.toUpperCase(), card.rect.x + card.rect.w / 2, card.rect.y + 28, {
        size: 22,
        align: "center",
        color: COLORS.bone,
        font: FONT.display,
      });
      // Diagram region.
      const diag = { x: card.rect.x + 10, y: card.rect.y + 44, w: card.rect.w - 20, h: card.rect.h - 74 };
      if (card.off) this.drawOffenseDiagram(r, diag, card.off);
      else if (card.def) this.drawDefenseDiagram(r, diag, card.def);

      const badge = card.off ? (card.off.isRun ? "RUN" : "PASS") : (card.def?.scheme.toUpperCase() ?? "");
      r.text(badge, card.rect.x + card.rect.w / 2, card.rect.y + card.rect.h - 15, {
        size: 12,
        align: "center",
        color: COLORS.blood,
        weight: "normal",
      });
    }
  }

  /** Mini route diagram: dots at the snap, lines tracing each receiver's route. */
  private drawOffenseDiagram(r: Renderer, d: Rect, play: OffensePlay): void {
    const ctx = r.ctx;
    const cx = d.x + d.w / 2;
    const losY = d.y + d.h * 0.74;
    let maxFwd = 12;
    for (const s of play.slots) for (const wp of s.route ?? []) maxFwd = Math.max(maxFwd, wp.fwd);
    const sy = (d.h * 0.66) / maxFwd;
    const sx = d.w / 46;
    const px = (lat: number) => cx + lat * sx;
    const py = (fwd: number) => losY - fwd * sy;

    // Line of scrimmage.
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(d.x, losY);
    ctx.lineTo(d.x + d.w, losY);
    ctx.stroke();

    for (const slot of play.slots) {
      const startX = px(slot.start.lat);
      const startY = py(slot.start.fwd);
      if (slot.route && slot.route.length) {
        ctx.strokeStyle = "#e0b21a";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        for (const wp of slot.route) ctx.lineTo(px(wp.lat), py(wp.fwd));
        ctx.stroke();
      }
      // Player dot (QB/run highlighted).
      ctx.fillStyle = slot.job === "qb" ? "#e11d2b" : slot.job === "run" ? "#7b8694" : "#fff";
      ctx.beginPath();
      ctx.arc(startX, startY, slot.job === "block" ? 2 : 3, 0, Math.PI * 2);
      ctx.fill();
      if (slot.job === "run") {
        ctx.strokeStyle = "#7b8694";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(startX, py(8));
        ctx.stroke();
      }
    }
  }

  /** Simple defensive scheme icon. */
  private drawDefenseDiagram(r: Renderer, d: Rect, play: DefensePlay): void {
    const ctx = r.ctx;
    const cx = d.x + d.w / 2;
    const losY = d.y + d.h * 0.4;
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(d.x, losY);
    ctx.lineTo(d.x + d.w, losY);
    ctx.stroke();

    const reds = [-1.6, -0.6, 0.6, 1.6];
    if (play.scheme === "blitz") {
      // Arrows charging the line.
      ctx.strokeStyle = "#e11d2b";
      ctx.lineWidth = 2;
      for (const k of reds) {
        const x = cx + k * 26;
        ctx.beginPath();
        ctx.moveTo(x, losY + 34);
        ctx.lineTo(x, losY + 6);
        ctx.moveTo(x - 4, losY + 12);
        ctx.lineTo(x, losY + 6);
        ctx.lineTo(x + 4, losY + 12);
        ctx.stroke();
      }
    } else if (play.scheme === "spy") {
      ctx.fillStyle = "#e11d2b";
      ctx.beginPath();
      ctx.arc(cx, losY + 22, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#e11d2b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, losY + 16);
      ctx.lineTo(cx, losY + 2);
      ctx.stroke();
    } else {
      // Coverage hooks.
      ctx.strokeStyle = "#7b8694";
      ctx.lineWidth = 2;
      for (const k of [-1.4, 0, 1.4]) {
        const x = cx + k * 30;
        ctx.beginPath();
        ctx.arc(x, losY + 20, 8, Math.PI, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
