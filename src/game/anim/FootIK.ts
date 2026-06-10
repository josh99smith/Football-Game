import * as THREE from "three";

/**
 * Analytic two-bone inverse kinematics — the core of foot IK.
 *
 * Given a leg's hip (root) and ankle (end effector) plus the *current* posed knee, find the knee
 * world position that places the ankle at `target` (or, when the target is out of reach, leaves the
 * leg fully extended toward it). The current knee defines the bend plane, so the solve keeps the
 * knee bending exactly the way the animation already poses it — no per-rig "forward axis" guesswork,
 * and no risk of the knee snapping inside-out.
 *
 * Pure geometry: nothing is mutated except `out`. Caller turns the returned knee position into bone
 * rotations (e.g. via the avatar's `aimBone`): aim hip→knee, then knee→target.
 */

const _ac = new THREE.Vector3();
const _u = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * @param hip     hip joint world position
 * @param kneeCur current (posed) knee world position — defines the bend direction
 * @param target  desired ankle world position
 * @param l1      thigh length (hip→knee)
 * @param l2      shin length (knee→ankle)
 * @param out     receives the solved knee world position
 * @returns true if `target` was within reach (false ⇒ leg fully extended toward it)
 */
export function solveTwoBone(
  hip: THREE.Vector3,
  kneeCur: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  out: THREE.Vector3,
): boolean {
  _ac.subVectors(target, hip);
  const dist = _ac.length();
  if (dist < 1e-5 || l1 < 1e-5 || l2 < 1e-5) {
    out.copy(kneeCur);
    return true;
  }
  const reach = l1 + l2;
  const reached = dist <= reach;
  // Clamp into the solvable range (slightly inside the limits to avoid singular straight/folded legs).
  const d = Math.min(Math.max(dist, Math.abs(l1 - l2) + 1e-4), reach - 1e-4);
  _u.copy(_ac).divideScalar(dist); // unit hip→target

  // Bend direction = the current knee's offset from the hip→target line (perpendicular component).
  _n.subVectors(kneeCur, hip);
  _n.addScaledVector(_u, -_n.dot(_u));
  if (_n.lengthSq() < 1e-8) {
    // Degenerate (current knee on the line): fall back to any perpendicular so the leg still bends.
    _n.set(-_u.y, _u.x, 0);
    if (_n.lengthSq() < 1e-8) _n.set(0, -_u.z, _u.y);
  }
  _n.normalize();

  // Law of cosines: angle at the hip between the hip→target axis and the thigh.
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  out.copy(hip).addScaledVector(_u, l1 * cosA).addScaledVector(_n, l1 * sinA);
  return reached;
}
