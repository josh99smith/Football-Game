import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { HUD } from "../../ui/HUD";
import { COLORS, grungeBackground } from "../../ui/Theme";
import { drawButton, tappedIn, type Rect } from "../../ui/widgets";
import { MenuState } from "./MenuState";
import { type OffensePlay, type DefensePlay } from "../Playbook";
import { cpuOffensePlay, cpuDefensePlay } from "../ai/PlayCaller";
import { PlayCallOverlay } from "../../ui/PlayCallOverlay";
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
  private overlay = new PlayCallOverlay();
  private exitRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(app: GameApp) {
    this.app = app;
    this.humanOffense = app.match.possession === app.match.humanTeam;
  }

  enter(): void {
    this.app.input.consumeTaps(); // clear stale taps from the prior screen
    this.overlay.layout(this.app.r, this.humanOffense);
  }

  update(): void {
    const taps = this.app.input.consumeTaps();
    if (this.app.match.practice && taps.some((t) => tappedIn(this.exitRect, [t]))) {
      this.app.audio.uiTap();
      this.app.setState(new MenuState(this.app));
      return;
    }
    const pick = this.overlay.pick(taps);
    if (pick) {
      this.app.audio.resume();
      this.app.audio.uiConfirm();
      this.choose(pick.off, pick.def);
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
    this.overlay.render(r);
    if (this.app.match.practice) {
      this.exitRect = { x: 14 + r.safe.left, y: 12 + r.safe.top, w: 84, h: 30 };
      drawButton(r, this.exitRect, "‹ EXIT", { fill: COLORS.concrete, size: 13 });
    }
  }
}
