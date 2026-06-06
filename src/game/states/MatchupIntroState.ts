import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { drawCrest } from "../../ui/Emblems";
import { COLORS, FONT, grungeBackground, hazardStripe } from "../../ui/Theme";
import { KickoffState } from "./KickoffState";

/**
 * Pre-game matchup intro: the two crews face off ("YOUR CREW vs RIVALS") before the opening
 * kickoff — a short hype bookend to the box score at the end. Taps (or a timer) start the game.
 */
export class MatchupIntroState implements GameState {
  private readonly app: GameApp;
  private t = 0;
  private done = false;

  constructor(app: GameApp) {
    this.app = app;
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.app.audio.resume();
    this.app.audio.organCharge();
  }

  update(dt: number): void {
    this.t += dt;
    const tapped = this.app.input.consumeTaps().length > 0;
    if (!this.done && (this.t > 3.4 || (this.t > 0.6 && tapped))) {
      this.done = true;
      this.app.audio.whistle();
      this.app.setState(new KickoffState(this.app, "HOME"));
    }
  }

  render(): void {
    const r = this.app.r;
    const ctx = r.ctx;
    const m = this.app.match;
    r.begin(COLORS.bg0);
    grungeBackground(ctx, r.width, r.height, this.t);

    const cx = r.width / 2;
    const cyMid = r.height / 2;
    // Slide the two crews in from opposite sides over the first beat.
    const slide = Math.min(1, this.t * 2.2);
    const ease = slide * slide * (3 - 2 * slide);
    const offset = (1 - ease) * r.width * 0.6;

    hazardStripe(ctx, 0, cyMid - 120, r.width, 10);
    r.text("GRIDIRON BLITZ", cx, cyMid - 150, { size: 22, align: "center", color: COLORS.bone, font: FONT.display });

    const home = m.home, away = m.away;
    const crestR = Math.min(56, r.width * 0.16);
    // Home crew slides in from the left, rivals from the right.
    drawCrest(ctx, cx - r.width * 0.26 - offset, cyMid - 10, crestR, home.config);
    drawCrest(ctx, cx + r.width * 0.26 + offset, cyMid - 10, crestR, away.config);

    r.text("VS", cx, cyMid - 10, { size: 40, align: "center", color: COLORS.blood, baseline: "middle", font: FONT.display });

    ctx.globalAlpha = ease;
    r.text(home.config.name.toUpperCase(), cx - r.width * 0.26, cyMid + crestR + 8, { size: 16, align: "center", color: COLORS.bone, font: FONT.display });
    r.text(away.config.name.toUpperCase(), cx + r.width * 0.26, cyMid + crestR + 8, { size: 16, align: "center", color: COLORS.bone, font: FONT.display });
    r.text("YOUR CREW", cx - r.width * 0.26, cyMid + crestR + 28, { size: 11, align: "center", color: COLORS.ash, weight: "normal", font: FONT.ui });
    r.text("RIVALS", cx + r.width * 0.26, cyMid + crestR + 28, { size: 11, align: "center", color: COLORS.ash, weight: "normal", font: FONT.ui });
    ctx.globalAlpha = 1;

    ctx.letterSpacing = "3px";
    r.text("NO REFS · NO MERCY · STREET RULES", cx, cyMid + 120, { size: 12, align: "center", color: COLORS.blood, weight: "normal", font: FONT.ui });
    ctx.letterSpacing = "0px";

    const a = 0.5 + 0.5 * Math.sin(this.t * 4);
    r.text("TAP TO KICK OFF", cx, r.height - 60, { size: 18, align: "center", color: COLORS.hazard, alpha: a, font: FONT.display });
  }
}
