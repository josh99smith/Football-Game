import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import type { TeamId } from "../entities/Player";
import { HUD } from "../../ui/HUD";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import { drawButton, tappedIn, type Rect } from "../../ui/widgets";
import { PX_PER_YARD } from "../Field";
import { SpecialTeamsState } from "./SpecialTeamsState";
import { PlaySelectState } from "./PlaySelectState";

/**
 * After a touchdown: kick the extra point (1, safe) or go for two (a goal-line play from the 2,
 * worth 2). The scoring team decides — the human picks, the CPU goes for two when it's chasing
 * points late.
 */
export class PatChoiceState implements GameState {
  private readonly app: GameApp;
  private readonly hud = new HUD();
  private readonly scoring: TeamId;
  private readonly humanScored: boolean;
  private kickRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private goRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private cpuTimer = 1.1;
  private cpuChoice: "kick" | "go" = "kick";

  constructor(app: GameApp, scoring: TeamId) {
    this.app = app;
    this.scoring = scoring;
    this.humanScored = scoring === app.match.humanTeam;
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.app.audio.resume();
    if (!this.humanScored) this.cpuChoice = this.decideCpu();
    this.layout();
  }

  private layout(): void {
    const r = this.app.r;
    const bw = Math.min(300, r.width - 60);
    const bh = 64;
    const cx = r.width / 2;
    this.kickRect = { x: cx - bw / 2, y: r.height / 2 - 10, w: bw, h: bh };
    this.goRect = { x: cx - bw / 2, y: r.height / 2 + 70, w: bw, h: bh };
  }

  private decideCpu(): "kick" | "go" {
    const m = this.app.match;
    const me = this.scoring;
    const diff = m.team(m.opponent(me)).score - m.team(me).score; // how far the kicker trails
    const late = m.quarter >= m.totalQuarters;
    // Chase two when down by a margin a 2 helps (8/5/2/1), more aggressively late.
    if (late && (diff === 2 || diff === 5 || diff === 1)) return "go";
    if (diff >= 9 && diff <= 16) return "go";
    return "kick";
  }

  update(dt: number): void {
    if (this.humanScored) {
      const taps = this.app.input.consumeTaps();
      if (tappedIn(this.kickRect, taps)) { this.app.audio.uiConfirm(); this.commit("kick"); }
      else if (tappedIn(this.goRect, taps)) { this.app.audio.uiConfirm(); this.commit("go"); }
      return;
    }
    this.cpuTimer -= dt;
    if (this.cpuTimer <= 0) this.commit(this.cpuChoice);
  }

  private commit(choice: "kick" | "go"): void {
    const m = this.app.match;
    if (choice === "kick") {
      const sp = m.attackGoalX(this.scoring) - m.attackDir(this.scoring) * 2 * PX_PER_YARD;
      this.app.setState(new SpecialTeamsState(this.app, { kind: "pat", kicking: this.scoring, spotX: sp }));
      return;
    }
    // Go for two: a goal-line snap from the 2, scored as a live play in LivePlayState.
    m.startSeries(this.scoring, m.attackGoalX(this.scoring) - m.attackDir(this.scoring) * 2 * PX_PER_YARD);
    m.twoPointActive = true;
    this.app.setState(new PlaySelectState(this.app));
  }

  render(): void {
    const r = this.app.r;
    r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, performance.now() / 1000);
    this.hud.render(r, this.app.match, { turbo: 1 });
    const m = this.app.match;
    const cx = r.width / 2;
    r.text(`${m.team(this.scoring).config.name.toUpperCase()} SCORE!`, cx, r.height / 2 - 90, { size: 30, align: "center", color: "#ff8a1e", font: FONT.display });
    r.text("EXTRA POINT", cx, r.height / 2 - 56, { size: 16, align: "center", color: COLORS.bone, font: FONT.ui });
    if (this.humanScored) {
      drawButton(r, this.kickRect, "KICK", { sub: "1 point — safe", accent: COLORS.hazard });
      drawButton(r, this.goRect, "GO FOR 2", { sub: "Goal-line play — 2 points", accent: COLORS.bloodBright });
    } else {
      const verb = this.cpuChoice === "go" ? "GOING FOR TWO" : "KICKING THE EXTRA POINT";
      r.text(verb, cx, r.height / 2 + 20, { size: 22, align: "center", color: COLORS.hazard, font: FONT.display });
    }
  }
}
