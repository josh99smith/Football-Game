import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { drawButton, drawPanel, tappedIn, type Rect } from "../../ui/widgets";
import { drawCrest } from "../../ui/Emblems";
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
    this.app.r.begin("#0c1f3a");

    const w = Math.min(420, r.width - 40);
    const h = 220;
    const x = (r.width - w) / 2;
    const y = r.height / 2 - h / 2 - 20;
    drawPanel(r, { x, y, w, h });

    r.text(this.headline, r.width / 2, y + 40, { size: 36, align: "center", color: "#ffd23a" });

    // Final score flanked by both team crests.
    const ctx = r.ctx;
    drawCrest(ctx, r.width / 2 - 110, y + 104, 30, m.home.config);
    drawCrest(ctx, r.width / 2 + 110, y + 104, 30, m.away.config);
    r.text(`${m.home.score}  —  ${m.away.score}`, r.width / 2, y + 104, {
      size: 40,
      align: "center",
      color: "#fff",
      baseline: "middle",
    });
    r.text(`${m.home.config.name}  vs  ${m.away.config.name}`, r.width / 2, y + 150, {
      size: 13,
      align: "center",
      color: "#9fd9b0",
      weight: "normal",
    });

    this.playRect = { x: r.width / 2 - 110, y: y + h - 30, w: 220, h: 52 };
    drawButton(r, this.playRect, "MAIN MENU", { fill: "#d03a3a", size: 22 });
  }
}
