import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { TeamId } from "../entities/Player";
import { HUD } from "../../ui/HUD";
import { drawPanel } from "../../ui/widgets";
import { PlaySelectState } from "./PlaySelectState";

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
      this.app.match.kickoffTo(this.receiving);
      this.app.setState(new PlaySelectState(this.app));
    }
  }

  render(): void {
    const r = this.app.r;
    this.app.r.begin("#0c1f3a");
    this.hud.render(r, this.app.match, { turbo: 1 });
    const w = Math.min(360, r.width - 40);
    const h = 90;
    const x = (r.width - w) / 2;
    const y = r.height / 2 - h / 2;
    drawPanel(r, { x, y, w, h });
    r.text("KICKOFF", r.width / 2, y + 34, { size: 30, align: "center", color: "#ffd23a" });
    const team = this.app.match.team(this.receiving);
    r.text(`${team.config.name} receive`, r.width / 2, y + 66, { size: 16, align: "center", color: "#eaf" });
  }
}
