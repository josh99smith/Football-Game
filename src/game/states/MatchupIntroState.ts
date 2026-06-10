import type { GameApp } from "../../engine/Game";
import type { GameState } from "../../engine/GameState";
import { drawCrest } from "../../ui/Emblems";
import { COLORS, FONT, hazardStripe } from "../../ui/Theme";
import { FIELD_LENGTH, FIELD_WIDTH, PX_PER_YARD } from "../Field";
import { KickoffState } from "./KickoffState";

const MID_X = FIELD_LENGTH / PX_PER_YARD / 2; // midfield, in world units (yards)
const MID_Z = FIELD_WIDTH / PX_PER_YARD / 2;

/**
 * Pre-game broadcast intro: a cinematic camera orbits the live 3D stadium in a continuous loop over
 * the branded midfield while the matchup (crests, "VS", clubs) fades up as a lower-third overlay.
 * The pan loops indefinitely until the player taps to blow the whistle and start the opening kickoff
 * — the 3D scene is auto-hidden on the state swap, so the kickoff card takes over cleanly.
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

  /** A continuously orbiting broadcast pan: the camera circles the stadium just outside the
   *  sidelines at a cinematic height, always looking at the branded midfield. It never ends — it
   *  loops until the player taps to kick off. */
  private camAt(t: number): { p: [number, number, number]; l: [number, number, number] } {
    const ang = t * 0.34; // ~18s per lap around the field
    const rx = 58; // elliptical orbit hugging the long field axis
    const rz = 30; // ...and sweeping just beyond each sideline
    const px = MID_X + Math.cos(ang) * rx;
    const pz = MID_Z + Math.sin(ang) * rz;
    const py = 24 + (1 + Math.sin(t * 0.25)) * 8; // gentle 24..40 rise/fall
    const lx = MID_X + Math.sin(t * 0.2) * 4; // look target drifts subtly around midfield
    const lz = MID_Z + Math.cos(t * 0.16) * 3;
    return { p: [px, py, pz], l: [lx, 3, lz] };
  }

  update(dt: number): void {
    this.t += dt;
    const c = this.camAt(this.t);
    this.app.scene3d.dollyCam(...c.p, ...c.l);

    // The pan loops indefinitely; only a tap (after a short grace) blows the whistle and kicks off.
    const tapped = this.app.input.consumeTaps().length > 0;
    if (!this.done && this.t > 0.6 && tapped) {
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
