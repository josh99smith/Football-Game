/**
 * Live-tunable procedural-animation constants, grouped into one mutable object so the in-game
 * DEBUG panel can adjust them on the fly (lil-gui binds to object properties). The values below are
 * the shipped defaults; Scene3D reads `ANIM.*` every frame, so edits take effect immediately.
 *
 * Kept in its own tiny module (no Scene3D import) so both the renderer and the debug UI can depend
 * on it without a cycle.
 */
export const ANIM = {
  // --- acceleration-based weight lean -------------------------------------------------------------
  // Decompose a player's low-passed acceleration into fore/aft + lateral and lean the body into it:
  // decelerate ⇒ lean back, accelerate ⇒ lean in, hard cut ⇒ bank. Sells weight & momentum.
  ACCEL_LEAN: true, // master toggle (A/B); off ⇒ exactly the prior turn-rate lean
  LEAN_ACCEL_GAIN: 0.00015, // rad per px/s^2 of fore/aft accel (tilt in on a burst reads clearly)
  LEAN_PITCH_MAX: 0.24, // clamp on the accel pitch contribution
  BANK_ACCEL_GAIN: 0.0001, // rad per px/s^2 of lateral accel (added to the turn bank)

  // --- procedural hip motion ----------------------------------------------------------------------
  // A speed-scaled vertical bob + a half-frequency weight-shift roll, so a running body rises/falls
  // and rocks side-to-side over the planted foot. Subtle; on the model group, never bones.
  PROC_HIP: true,
  HIP_BOB_AMP: 0.032, // vertical hip rise/fall (world units) at full forward sprint
  HIP_ROLL_AMP: 0.022, // side-to-side weight-shift roll (rad), half the bob frequency

  // --- foot IK ------------------------------------------------------------------------------------
  // After the mixer poses the skeleton, pull planted feet down onto the ground plane via two-bone IK
  // so they stop floating/skating. FOOT_PLANT_* are sole heights (world units) bounding the
  // plant→swing fade — most likely to need tuning to the avatar's world scale.
  FOOT_IK: true, // master toggle
  FOOT_IK_WEIGHT: 1, // 0..1 global blend of the ground correction
  FOOT_PLANT_LO: 0.03, // sole at/under this height ⇒ fully planted (corrected)
  FOOT_PLANT_HI: 0.18, // sole above this ⇒ swinging (left untouched)

  // --- locomotion blend feel ----------------------------------------------------------------------
  // The idle↔walk↔run↔backpedal↔strafe weight blend and how briskly it carves between states. These
  // were module-level consts; surfaced here so the blend can be perfected live like the rest.
  TURN_RATE: 14, // rendered yaw slew (rad/s), scaled down with speed so slow players pivot sharply
  IDLE_OUT: 0.06, // speed01 below this is a pure idle stance
  MOVE_FULL: 0.16, // speed01 above this is fully in locomotion (idle faded out) — commit to a stride sooner
  WALK_TO_RUN_LO: 0.3, // below this, forward motion is the walk cycle
  WALK_TO_RUN_HI: 0.58, // above this, forward motion is the run cycle (slightly earlier → less mushy jog band)
  BLEND_TIME: 0.13, // locomotion crossfade time (s) — a touch snappier so direction changes read crisply

  // --- foot-plant stride warps --------------------------------------------------------------------
  // timeScale = speed(px/s) * K, calibrated from each clip's authored stride speed so feet grip the
  // ground at any pace. DO NOT eyeball these — wrong values reintroduce skating. Tunable for calibration.
  PLANT_RUN: 0.0124, // run clip strides ~4.6 yd/s
  PLANT_WALK: 0.0369, // walk clip ~1.7 yd/s
  PLANT_BACK: 0.0194, // backpedal clip ~3.2 yd/s
  PLANT_STRAFE: 0.0163, // strafe clip ~3.8 yd/s

  // --- one-shot overlay envelope ------------------------------------------------------------------
  // Every action clip (catch/juke/spin/tackle/…) ramps in then out, ducking locomotion under it. Snappy
  // ramps make the move land ON the game event; the in/out are auto-capped to the clip's length so even
  // a very short overlay still reaches full weight (see triggerOneShot).
  ONESHOT_IN: 0.12, // ramp-in (s) — fast so the move reads the instant the event fires
  ONESHOT_OUT: 0.28, // ramp-out (s) — return to locomotion without a lingering tail
  THROW_DUR: 0.5, // seconds of the procedural QB throw (the fallback when the mocap throw clip is absent)
};

/**
 * Per-one-shot clip timing — the "slice": where to start in the (often long) source mocap (`start`,
 * seconds), how long to let it own the body (`dur`, seconds of real time), and how fast to play it
 * (`rate`, a playback multiplier). Surfaced so each move can be sliced to land exactly on its game
 * event. `start` for clips synced to a precise ball moment (pass/catch) is calibrated — change with
 * care; the standalone moves (juke/spin/dive) are free to exaggerate for arcade snap.
 */
export interface ClipTiming { start: number; dur: number; rate: number; }
export const CLIP_TIMING: Record<string, ClipTiming> = {
  // Synced to the ball leaving / arriving — calibrated, leave the slice points alone.
  pass: { start: 5.4, dur: 0.85, rate: 1.45 },
  hailMary: { start: 5.3, dur: 1.0, rate: 1.25 },
  catch: { start: 0.85, dur: 0.85, rate: 1.5 },
  // Standalone ball-carrier moves — pushed snappier/more explosive for arcade punch.
  juke: { start: 0, dur: 0.5, rate: 1.4 }, // sharper plant-and-cut
  spin: { start: 0, dur: 0.9, rate: 1.2 }, // tighter spin
  stiffArm: { start: 0, dur: 0.5, rate: 1.35 },
  dive: { start: 0.0, dur: 1.0, rate: 1.55 }, // explosive launch
  turnRun: { start: 0.0, dur: 0.7, rate: 1.5 },
  // Contact + special-teams — synced to contact/kick, kept as tuned.
  tackle: { start: 1.0, dur: 1.4, rate: 1.1 },
  tackleMade: { start: 1.05, dur: 1.15, rate: 1.35 }, // defender's hit lands a hair quicker
  swat: { start: 0.3, dur: 0.95, rate: 1.2 },
  kick: { start: 2.6, dur: 1.2, rate: 1.2 },
  pickup: { start: 0.05, dur: 1.0, rate: 1.3 },
  celebrate: { start: 0, dur: 2.6, rate: 1.0 }, // start is overridden per-variant slice point
};

export type AnimTuning = typeof ANIM;
