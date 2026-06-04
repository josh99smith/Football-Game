import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { Renderer } from "../../engine/Renderer";
import { HUD } from "../../ui/HUD";
import { drawPanel, tappedIn, type Rect } from "../../ui/widgets";
import { pick } from "../../engine/math/random";
import {
  OFFENSE_PLAYS,
  DEFENSE_PLAYS,
  type OffensePlay,
  type DefensePlay,
} from "../Playbook";
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
    const offensePlay = off ?? pick(OFFENSE_PLAYS);
    const defensePlay = def ?? pick(DEFENSE_PLAYS);
    this.app.setState(new LivePlayState(this.app, offensePlay, defensePlay));
  }

  render(): void {
    const r = this.app.r;
    this.app.r.begin("#0a2b14");
    this.hud.render(r, this.app.match, { turbo: 1 });

    const title = this.humanOffense ? "CALL YOUR PLAY — OFFENSE" : "CALL YOUR PLAY — DEFENSE";
    r.text(title, r.width / 2, r.height / 2 - r.height * 0.24, {
      size: 22,
      align: "center",
      color: "#ffd23a",
    });

    for (const card of this.cards) {
      const name = card.off?.name ?? card.def?.name ?? "";
      const blurb = card.off?.blurb ?? card.def?.blurb ?? "";
      drawPanel(r, card.rect, "rgba(10,40,22,0.95)");
      r.text(name, card.rect.x + card.rect.w / 2, card.rect.y + 30, {
        size: 22,
        align: "center",
        color: "#fff",
      });
      wrapText(r, blurb, card.rect.x + 12, card.rect.y + 58, card.rect.w - 24, 18);
      const badge = card.off ? (card.off.isRun ? "RUN" : "PASS") : (card.def?.name ?? "");
      r.text(card.off ? badge : "MAN/ZONE", card.rect.x + card.rect.w / 2, card.rect.y + card.rect.h - 18, {
        size: 12,
        align: "center",
        color: "#9fd9b0",
        weight: "normal",
      });
    }
  }
}

function wrapText(
  r: Renderer,
  text: string,
  x: number,
  y: number,
  maxW: number,
  lh: number,
): void {
  const words = text.split(" ");
  let line = "";
  let yy = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (r.measureText(test, 14) > maxW && line) {
      r.text(line, x, yy, { size: 14, color: "#cfe", weight: "normal" });
      line = word;
      yy += lh;
    } else {
      line = test;
    }
  }
  if (line) r.text(line, x, yy, { size: 14, color: "#cfe", weight: "normal" });
}
