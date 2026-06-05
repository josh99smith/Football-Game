import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { HUD } from "../../ui/HUD";
import { COLORS, FONT, grungeBackground } from "../../ui/Theme";
import { drawButton, tappedIn, type Rect } from "../../ui/widgets";
import { chance } from "../../engine/math/random";
import { SpecialTeamsState } from "./SpecialTeamsState";
import { PlaySelectState } from "./PlaySelectState";

type Choice = "go" | "punt" | "fg";

/**
 * The 4th-down decision: go for it, punt, or attempt a field goal. The human picks for their own
 * team; the CPU decides situationally (kick in range, punt to flip the field, gamble on short
 * yardage or when desperate) after a short beat.
 */
export class FourthDownState implements GameState {
  private readonly app: GameApp;
  private readonly hud = new HUD();
  private readonly humanOffense: boolean;
  private buttons: { rect: Rect; choice: Choice }[] = [];
  private cpuTimer = 1.1;
  private cpuChoice: Choice | null = null;
  private fgDist: number;

  constructor(app: GameApp) {
    this.app = app;
    const m = app.match;
    this.humanOffense = m.possession === m.humanTeam;
    this.fgDist = m.fieldGoalYards(m.possession, m.losX);
  }

  enter(): void {
    this.app.input.consumeTaps();
    this.app.audio.resume();
    if (!this.humanOffense) this.cpuChoice = this.decideCpu();
    this.layout();
  }

  private layout(): void {
    const r = this.app.r;
    const inRange = this.fgDist <= 55;
    const choices: { choice: Choice; on: boolean }[] = [
      { choice: "go", on: true },
      { choice: "punt", on: true },
      { choice: "fg", on: inRange },
    ];
    const bw = Math.min(300, r.width - 60);
    const bh = 64;
    const gap = 16;
    const totalH = choices.length * bh + (choices.length - 1) * gap;
    const startY = r.height / 2 - totalH / 2 + 20;
    this.buttons = choices
      .filter((c) => c.on)
      .map((c, i) => ({
        rect: { x: (r.width - bw) / 2, y: startY + i * (bh + gap), w: bw, h: bh },
        choice: c.choice,
      }));
  }

  update(dt: number): void {
    if (this.humanOffense) {
      const taps = this.app.input.consumeTaps();
      for (const b of this.buttons) {
        if (tappedIn(b.rect, taps)) { this.app.audio.uiConfirm(); this.commit(b.choice); return; }
      }
      return;
    }
    // CPU: brief beat, then act.
    this.cpuTimer -= dt;
    if (this.cpuTimer <= 0 && this.cpuChoice) this.commit(this.cpuChoice);
  }

  private decideCpu(): Choice {
    const m = this.app.match;
    const me = m.possession;
    const behind = m.team(me).score < m.team(m.opponent(me)).score;
    const late = m.quarter >= m.totalQuarters && m.clock < 60;
    // In field-goal range: take the points.
    if (this.fgDist <= 45) return "fg";
    if (this.fgDist <= 52 && !behind) return "fg";
    // Short yardage or desperate: gamble.
    if (m.distanceYards <= 2 && chance(0.55)) return "go";
    if (late && behind) return "go";
    // Otherwise flip the field.
    return "punt";
  }

  private commit(choice: Choice): void {
    const m = this.app.match;
    if (choice === "go") { this.app.setState(new PlaySelectState(this.app)); return; }
    const kind = choice === "fg" ? "fg" : "punt";
    this.app.setState(new SpecialTeamsState(this.app, { kind, kicking: m.possession, spotX: m.losX }));
  }

  render(): void {
    const r = this.app.r;
    r.begin(COLORS.bg0);
    grungeBackground(r.ctx, r.width, r.height, performance.now() / 1000);
    this.hud.render(r, this.app.match, { turbo: 1 });

    const m = this.app.match;
    const cx = r.width / 2;
    r.text("4TH DOWN", cx, 92, { size: 44, align: "center", color: COLORS.bloodBright, font: FONT.display });
    r.text(`${m.distanceYards} TO GO  •  ${m.fieldSideLabel()}`, cx, 126, { size: 18, align: "center", color: COLORS.bone, font: FONT.ui });

    if (this.humanOffense) {
      for (const b of this.buttons) {
        const label = b.choice === "go" ? "GO FOR IT" : b.choice === "punt" ? "PUNT" : "FIELD GOAL";
        const sub = b.choice === "go" ? "Run a play" : b.choice === "punt" ? "Flip the field" : `${this.fgDist} yd attempt`;
        const accent = b.choice === "fg" ? COLORS.hazard : b.choice === "go" ? COLORS.bloodBright : COLORS.steel;
        drawButton(r, b.rect, label, { sub, accent });
      }
    } else {
      const name = m.team(m.possession).config.name.toUpperCase();
      const verb = this.cpuChoice === "go" ? "GOING FOR IT" : this.cpuChoice === "fg" ? "KICKING A FIELD GOAL" : "PUNTING";
      r.text(`${name}…`, cx, r.height / 2, { size: 30, align: "center", color: COLORS.bone, font: FONT.display });
      r.text(verb, cx, r.height / 2 + 36, { size: 22, align: "center", color: COLORS.hazard, font: FONT.display });
    }
  }
}
