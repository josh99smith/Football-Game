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

    const w = Math.min(460, r.width - 32);
    const h = 460;
    const x = (r.width - w) / 2;
    const y = Math.max(20, r.height / 2 - h / 2 - 10);
    drawPanel(r, { x, y, w, h });

    const win = m.winner() === "HOME";
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "2px";
    r.text(this.headline, r.width / 2, y + 40, { size: 40, align: "center", color: win ? COLORS.bone : COLORS.blood, font: FONT.display });
    ctx.restore();

    // Final score flanked by both team crests.
    drawCrest(ctx, r.width / 2 - 120, y + 100, 28, m.home.config);
    drawCrest(ctx, r.width / 2 + 120, y + 100, 28, m.away.config);
    r.text(`${m.home.score} — ${m.away.score}`, r.width / 2, y + 100, {
      size: 44, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display,
    });

    // Box score: a column for each team with the headline stats.
    const s = m.stats;
    const rows: [string, string | number, string | number][] = [
      ["TOTAL YARDS", s.HOME.totalYards, s.AWAY.totalYards],
      ["FIRST DOWNS", s.HOME.firstDowns, s.AWAY.firstDowns],
      ["TOUCHDOWNS", s.HOME.touchdowns, s.AWAY.touchdowns],
      ["FIELD GOALS", s.HOME.fieldGoals, s.AWAY.fieldGoals],
      ["SACKS", s.HOME.sacks, s.AWAY.sacks],
      ["TAKEAWAYS", s.HOME.takeaways, s.AWAY.takeaways],
      ["LONGEST", `${s.HOME.longest}yd`, `${s.AWAY.longest}yd`],
    ];
    const tableY = y + 150;
    const colHome = x + 70;
    const colAway = x + w - 70;
    r.text(m.home.config.abbr, colHome, tableY, { size: 16, align: "center", color: COLORS.hazard, font: FONT.display });
    r.text("STAT", r.width / 2, tableY, { size: 12, align: "center", color: COLORS.ash, weight: "normal" });
    r.text(m.away.config.abbr, colAway, tableY, { size: 16, align: "center", color: COLORS.hazard, font: FONT.display });
    rows.forEach((row, i) => {
      const ry = tableY + 26 + i * 27;
      ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0)";
      ctx.fillRect(x + 12, ry - 13, w - 24, 25);
      r.text(String(row[1]), colHome, ry, { size: 17, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
      r.text(row[0], r.width / 2, ry, { size: 11, align: "center", color: COLORS.ash, baseline: "middle", weight: "normal" });
      r.text(String(row[2]), colAway, ry, { size: 17, align: "center", color: COLORS.bone, baseline: "middle", font: FONT.display });
    });

    this.playRect = { x: r.width / 2 - 110, y: y + h - 32, w: 220, h: 50 };
    drawButton(r, this.playRect, "BACK TO THE STREETS", { fill: COLORS.concrete, accent: COLORS.blood, size: 17 });
  }
}
