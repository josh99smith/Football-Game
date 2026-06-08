import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { drawCrest } from "../../ui/Emblems";
import { COLORS, FONT, hazardStripe } from "../../ui/Theme";
import { FIELD_LENGTH, FIELD_WIDTH, PX_PER_YARD } from "../Field";
import { KickoffState } from "./KickoffState";

const DUR = 4.0; // length of the pre-game flythrough before the auto-kickoff
const MID_X = FIELD_LENGTH / PX_PER_YARD / 2; // midfield, in world units (yards)
const MID_Z = FIELD_WIDTH / PX_PER_YARD / 2;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Pre-game broadcast intro: a cinematic camera cranes down over the live 3D stadium toward the
 * branded midfield while the matchup (crests, "VS", clubs) fades up as a lower-third overlay. A tap
 * (or the timer) blows the whistle and starts the opening kickoff — the 3D scene is auto-hidden on
 * the state swap, so the kickoff card takes over cleanly.
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
    this.app.audio.startCrowd();
    this.app.scene3d.setVisible(true); // show the stadium under the overlay
    // Prime the camera at the start pose twice so the first interpolated frame doesn't snap.
    const c = this.camAt(0);
    this.app.scene3d.dollyCam(...c.p, ...c.l);
    this.app.scene3d.dollyCam(...c.p, ...c.l);
  }

  /** Crane-down, push-in flythrough toward the branded midfield, with a touch of lateral drift. */
  private camAt(t: number): { p: [number, number, number]; l: [number, number, number] } {
    const k = Math.min(1, t / DUR);
    const e = k * k * (3 - 2 * k); // smoothstep
    const px = MID_X + Math.sin(t * 0.5) * 12;       // gentle parallax drift
    const py = lerp(54, 13, e);                      // crane down
    const pz = lerp(-46, -12, e);                    // push in from beyond the sideline
    const lx = MID_X + Math.sin(t * 0.35) * 5;
    return { p: [px, py, pz], l: [lx, 2, MID_Z] };
  }

  update(dt: number): void {
    this.t += dt;
    const c = this.camAt(this.t);
    this.app.scene3d.dollyCam(...c.p, ...c.l);

    const tapped = this.app.input.consumeTaps().length > 0;
    if (!this.done && (this.t > DUR || (this.t > 0.6 && tapped))) {
      this.done = true;
      this.app.audio.whistle();
      this.app.setState(new KickoffState(this.app, "HOME"));
    }
  }

  render(alpha = 1): void {
    const r = this.app.r;
    const ctx = r.ctx;
    const m = this.app.match;

    // The live stadium is the backdrop; the 2D layer stays transparent over it.
    this.app.scene3d.render(alpha);

    // Legibility scrim: darken the top and bottom thirds so the overlay text reads over the turf.
    const top = ctx.createLinearGradient(0, 0, 0, r.height);
    top.addColorStop(0, "rgba(6,8,12,0.82)");
    top.addColorStop(0.34, "rgba(6,8,12,0.0)");
    top.addColorStop(0.66, "rgba(6,8,12,0.0)");
    top.addColorStop(1, "rgba(6,8,12,0.9)");
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, r.width, r.height);

    const cx = r.width / 2;
    const titleY = Math.max(28, r.height * 0.1);
    hazardStripe(ctx, cx - r.width * 0.32, titleY + 14, r.width * 0.64, 8);
    r.text("GRIDIRON BLITZ", cx, titleY, { size: 22, align: "center", color: COLORS.bone, font: FONT.display });

    // Matchup lower-third: crests slide in from the sides and the names fade up.
    const home = m.home, away = m.away;
    const slide = Math.min(1, this.t * 1.6);
    const ease = slide * slide * (3 - 2 * slide);
    const offset = (1 - ease) * r.width * 0.55;
    const rowY = r.height * 0.8;
    const crestR = Math.min(50, r.width * 0.13);

    drawCrest(ctx, cx - r.width * 0.27 - offset, rowY, crestR, home.config);
    drawCrest(ctx, cx + r.width * 0.27 + offset, rowY, crestR, away.config);
    r.text("VS", cx, rowY, { size: 36, align: "center", color: COLORS.blood, baseline: "middle", font: FONT.display });

    ctx.globalAlpha = ease;
    r.text(home.config.name.toUpperCase(), cx - r.width * 0.27, rowY + crestR + 16, { size: 15, align: "center", color: COLORS.bone, font: FONT.display });
    r.text(away.config.name.toUpperCase(), cx + r.width * 0.27, rowY + crestR + 16, { size: 15, align: "center", color: COLORS.bone, font: FONT.display });
    ctx.globalAlpha = 1;

    const a = 0.5 + 0.5 * Math.sin(this.t * 4);
    r.text("TAP TO KICK OFF", cx, r.height - 24, { size: 16, align: "center", color: COLORS.hazard, alpha: a, font: FONT.display });
  }
}
