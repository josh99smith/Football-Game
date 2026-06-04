import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { PlayOutcome } from "../Match";
import { HUD } from "../../ui/HUD";
import { drawPanel } from "../../ui/widgets";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import { PlaySelectState } from "./PlaySelectState";
import { KickoffState } from "./KickoffState";
import { GameOverState } from "./GameOverState";

/**
 * Brief between-plays beat: applies the finished play to the rules, shows a result
 * banner, then routes to the next phase (kickoff after a score, game over at time,
 * or the next play selection). Auto-advances or can be skipped with a tap.
 */
export class PlayResultState implements GameState {
  private readonly app: GameApp;
  private readonly outcome: PlayOutcome;
  private timer = 1.7;
  private hud = new HUD();
  private banner = "";
  private detail = "";
  private result!: ReturnType<GameApp["match"]["applyOutcome"]>;
  private advanced = false;

  constructor(app: GameApp, outcome: PlayOutcome) {
    this.app = app;
    this.outcome = outcome;
  }

  enter(): void {
    this.result = this.app.match.applyOutcome(this.outcome);
    this.banner = this.outcome.headline;
    if (this.result.scored && this.result.scoringTeam) {
      const t = this.app.match.team(this.result.scoringTeam);
      this.detail = `${t.config.name} score!`;
    } else if (this.outcome.firstDown) {
      this.detail = "FIRST DOWN!";
      this.app.audio.firstDownChime();
    } else if (this.result.changedPossession) {
      this.detail = "TURNOVER!";
    } else {
      this.detail = `${ordinal(this.app.match.down)} & ${this.app.match.distanceYards}`;
    }
  }

  update(dt: number): void {
    this.timer -= dt;
    if ((this.timer <= 0 || this.app.input.consumeTaps().length > 0) && !this.advanced) {
      this.advanced = true;
      this.next();
    }
  }

  private next(): void {
    const m = this.app.match;
    if (m.isOver) {
      this.app.setState(new GameOverState(this.app));
      return;
    }
    if (this.result.kickoff && this.result.kickReceiver) {
      // applyOutcome decides who receives (after a safety the conceding team kicks).
      this.app.setState(new KickoffState(this.app, this.result.kickReceiver));
      return;
    }
    this.app.setState(new PlaySelectState(this.app));
  }

  render(): void {
    const r = this.app.r;
    this.app.r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, performance.now() / 1000);
    this.hud.render(r, this.app.match, { turbo: 1 });

    const w = Math.min(440, r.width - 40);
    const h = 116;
    const x = (r.width - w) / 2;
    const y = r.height / 2 - h / 2;
    drawPanel(r, { x, y, w, h });
    const ctx = r.ctx;
    ctx.save();
    ctx.letterSpacing = "1px";
    r.text(this.banner.toUpperCase(), r.width / 2, y + 42, { size: 34, align: "center", color: COLORS.bone, font: FONT.display });
    ctx.restore();
    r.text(this.detail.toUpperCase(), r.width / 2, y + 80, { size: 18, align: "center", color: COLORS.blood, font: FONT.ui });
    r.text("TAP TO CONTINUE", r.width / 2, y + h + 16, {
      size: 12,
      align: "center",
      color: COLORS.ash,
      weight: "normal",
    });
  }
}

function ordinal(n: number): string {
  return n === 1 ? "1ST" : n === 2 ? "2ND" : n === 3 ? "3RD" : `${n}TH`;
}
