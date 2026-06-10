import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { TeamId } from "../entities/Player";
import { HUD } from "../../ui/HUD";
import { drawPanel } from "../../ui/widgets";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import { LivePlayState } from "./LivePlayState";
import { OFFENSE_PLAYS, DEFENSE_PLAYS } from "../Playbook";

/**
 * Lightweight kickoff: shows a banner, then spots the ball at the receiving team's
 * own 25 (arcade touchback) and proceeds to play selection. Kept brief to preserve
 * the fast pace; a full return mini-game could slot in here later.
 */
export class KickoffState implements GameState {
  private readonly app: GameApp;
  private readonly receiving: TeamId;
  private timer = 1.4;
  private hud = new HUD();
  private done = false;

  constructor(app: GameApp, receiving: TeamId) {
    this.app = app;
    this.receiving = receiving;
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.app.audio.whistle();
    this.app.audio.organCharge();
  }

  update(dt: number): void {
    this.timer -= dt;
    if ((this.timer <= 0 || this.app.input.consumeTaps().length > 0) && !this.done) {
      this.done = true;
      // Field the kick deep and run it back live — a tackle spots the receiving team's drive,
      // a house call is a return TD.
      const m = this.app.match;
      m.possession = this.receiving; // the returner's team is on "offense" for the return
      const ballX = m.ownYardX(this.receiving, 9);
      this.app.setState(new LivePlayState(this.app, OFFENSE_PLAYS[0], DEFENSE_PLAYS[0], { receiver: this.receiving, ballX }));
    }
  }

  render(): void {
    const r = this.app.r;
    this.app.r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, performance.now() / 1000);
    this.hud.render(r, this.app.match, { turbo: 1 });
    const w = Math.min(380, r.width - 40);
    const h = 96;
    const x = (r.width - w) / 2;
    const y = r.height / 2 - h / 2;
    drawPanel(r, { x, y, w, h });
    r.text("KICKOFF", r.width / 2, y + 38, { size: 34, align: "center", color: COLORS.bone, font: FONT.display });
    const team = this.app.match.team(this.receiving);
    r.text(`${team.config.name.toUpperCase()} RECEIVE`, r.width / 2, y + 70, { size: 16, align: "center", color: COLORS.blood, font: FONT.ui });
  }
}
