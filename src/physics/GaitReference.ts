/**
 * A single parametric human gait cycle — the reference the active-ragdoll muscles track.
 *
 * This is NOT a clip, a paired animation, or motion-matching: it's one normalized cycle of
 * sagittal joint angles (degrees) over phase φ∈[0,1), shaped after clinical gait data
 * (heel-strike at φ=0, toe-off ~0.6, swing 0.6→1). The physics still owns mass, contact,
 * balance and foot-lock; the muscles PD-track these angles and deviate from them on impact.
 * Both legs share the curve at a half-cycle offset; arms swing contralaterally.
 *
 * Angles are returned as flexion conventions:
 *   hip   +forward (thigh swings ahead),  knee +flexion (heel tucks back),
 *   ankle +dorsiflexion (toes up),        shoulder +forward,  elbow +flexion.
 * The controller maps these to the ragdoll's joint axes.
 */

const D2R = Math.PI / 180;
const TAU = Math.PI * 2;

function gaussian(x: number, mu: number, sigma: number): number {
  const d = (x - mu) / sigma;
  return Math.exp(-0.5 * d * d);
}
/** Wrap a phase to [0,1). */
function wrap01(p: number): number {
  return p - Math.floor(p);
}

/** Live-tunable shape of the reference gait (amplitudes in degrees). */
export interface GaitTuning {
  hipAmp: number; // peak hip flexion swing (deg)
  hipBias: number; // mean hip flexion (deg, slight forward)
  kneeStance: number; // loading-response knee flexion bump (deg)
  kneeSwing: number; // swing knee flexion to clear the foot (deg)
  kneeBase: number; // baseline knee flexion (deg)
  anklePush: number; // plantarflexion at push-off (deg)
  ankleDorsi: number; // dorsiflexion in swing to clear the toe (deg)
  armAmp: number; // shoulder swing amplitude (deg)
  elbowBend: number; // steady elbow flexion (deg)
  spineLean: number; // steady forward trunk lean (deg) — small!
}

export const defaultGait: GaitTuning = {
  hipAmp: 26,
  hipBias: 6,
  kneeStance: 16,
  kneeSwing: 62,
  kneeBase: 4,
  anklePush: 16,
  ankleDorsi: 6,
  armAmp: 26,
  elbowBend: 22,
  spineLean: 6,
};

export interface LegAngles { hip: number; knee: number; ankle: number } // radians

/** Sagittal hip/knee/ankle (radians) for a leg at its local cycle phase. */
export function legAngles(phi: number, g: GaitTuning, out: LegAngles): LegAngles {
  phi = wrap01(phi);
  // Hip: max flexion near heel-strike (φ=0), max extension near mid-stance (φ≈0.5).
  const hip = g.hipBias + g.hipAmp * Math.cos(TAU * phi);
  // Knee: small stance bump (loading) + large swing bump (foot clearance); never negative.
  const knee = g.kneeBase + g.kneeStance * gaussian(phi, 0.16, 0.11) + g.kneeSwing * gaussian(phi, 0.72, 0.12);
  // Ankle: plantarflex push-off just before toe-off, mild dorsiflexion through swing.
  const ankle = -g.anklePush * gaussian(phi, 0.56, 0.07) + g.ankleDorsi * gaussian(phi, 0.85, 0.16);
  out.hip = hip * D2R;
  out.knee = Math.max(0, knee) * D2R;
  out.ankle = ankle * D2R;
  return out;
}

/** Contralateral shoulder swing (radians, +forward) for a leg phase. Arm goes back as the
 * same-side leg swings forward. */
export function armFlex(phi: number, g: GaitTuning): number {
  return -g.armAmp * Math.cos(TAU * wrap01(phi)) * D2R;
}

export function elbowFlex(g: GaitTuning): number {
  return g.elbowBend * D2R;
}
export function spineLean(g: GaitTuning): number {
  return g.spineLean * D2R;
}
