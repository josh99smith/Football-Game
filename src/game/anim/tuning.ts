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
  LEAN_ACCEL_GAIN: 0.00012, // rad per px/s^2 of fore/aft accel
  LEAN_PITCH_MAX: 0.2, // clamp on the accel pitch contribution
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
};

export type AnimTuning = typeof ANIM;
