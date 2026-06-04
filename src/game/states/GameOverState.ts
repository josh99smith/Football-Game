import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { drawButton, drawPanel, tappedIn, type Rect } from "../../ui/widgets";
import { drawCrest } from "../../ui/Emblems";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import { saveHighScore } from "../storage";
import { MenuState } from "./MenuState";

/** Final whistle: shows the score, records a high score, returns to the menu. */
export class GameOverState implements GameState {
  private readonly app: GameApp;
  private playRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private headline = "";
  private t = 0;

  constructor(app: GameApp) {
    this.app = app;
  }

  enter(): void {
    const m = this.app.match;
    const winner = m.winner();
    if (winner === "HOME") this.headline = "YOU WIN!";
    else if (winner === "AWAY") this.headline = "YOU LOSE";
    else this.headline = "TIE GAME";

    this.app.highScores = saveHighScore({
      team: m.home.config.name,
      points: m.home.score,
      opponent: m.away.config.name,
      opponentPoints: m.away.score,
      date: Date.now(),
    });
    this.app.audio.score();
    this.app.input.consumeTaps();
  }

  update(dt: number): void {
    this.t += dt;
    const taps = this.app.input.consumeTaps();
    if (this.t > 0.5 && tappedIn(this.playRect, taps)) {
      this.app.audio.uiConfirm();
      this.app.setState(new MenuState(this.app));
    }
  }

  render(): void {
    const r = this.app.r;
    const m = this.app.match;
    this.app.r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, this.t);

    const w = Math.min(440, r.width - 40);
    const h = 220;
    const x = (r.width - w) / 2;
    const y = r.height / 2 - h / 2 - 20;
    drawPanel(r, { x, y, w, h });

    const win = m.winner() === "HOME";
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "2px";
    r.text(this.headline, r.width / 2, y + 44, { size: 44, align: "center", color: win ? COLORS.bone : COLORS.blood, font: FONT.display });
    ctx.restore();

    // Final score flanked by both team crests.
    drawCrest(ctx, r.width / 2 - 110, y + 108, 30, m.home.config);
    drawCrest(ctx, r.width / 2 + 110, y + 108, 30, m.away.config);
    r.text(`${m.home.score} — ${m.away.score}`, r.width / 2, y + 108, {
      size: 44,
      align: "center",
      color: COLORS.bone,
      baseline: "middle",
      font: FONT.display,
    });
    r.text(`${m.home.config.name.toUpperCase()}  VS  ${m.away.config.name.toUpperCase()}`, r.width / 2, y + 152, {
      size: 13,
      align: "center",
      color: COLORS.ash,
      weight: "normal",
    });

    this.playRect = { x: r.width / 2 - 110, y: y + h - 30, w: 220, h: 52 };
    drawButton(r, this.playRect, "BACK TO THE STREETS", { fill: COLORS.concrete, accent: COLORS.blood, size: 18 });
  }
}
