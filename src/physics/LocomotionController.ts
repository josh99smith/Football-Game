import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { PhysicsWorld } from "./PhysicsWorld";
import type { Ragdoll } from "./Ragdoll";

/**
 * Slice 2: procedural locomotion + balance on top of the active ragdoll.
 *
 * Nothing here is a clip. The body is a free dynamic ragdoll (chest no longer pinned);
 * three things keep it upright and moving:
 *
 *  1. Foot-lock — a planted (stance) foot is pinned to the ground with a temporary
 *     spherical joint so it CANNOT slide (foot-slide is the non-negotiable bug). The
 *     leg pivots freely about that locked point; on lift the joint is removed.
 *  2. Balance assist — a root stabilization wrench on the pelvis/chest: a PD torque that
 *     keeps the trunk upright and a horizontal force that keeps the centre of mass over
 *     the support feet (and drives it toward the desired travel speed). This is the
 *     "motor intent to stay balanced"; its strength is a single `assist` knob (1 = full
 *     training wheels, 0 = pure muscle) so we can wean it down as the muscles improve.
 *  3. Procedural gait — a two-state step machine (left-swing / right-swing) drives the
 *     swing leg through hand-keyed hip/knee angle curves whose amplitude scales with the
 *     desired speed. The stance hip stays compliant so the pelvis can travel over the
 *     locked foot; the stance knee stays stiff (a supporting strut).
 *
 * All gains/timings are public and surfaced live in the debug panel.
 */

type Side = "L" | "R";

interface Leg {
  side: Side;
  hip: string;
  knee: string;
  ankle: string;
  foot: string;
  planted: boolean;
  lock: RAPIER.ImpulseJoint | null;
  /** World point the foot was pinned to when it last planted (for live slip read-out). */
  anchor: THREE.Vector3;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _qTarget = new THREE.Quaternion();
const _qErrT = new THREE.Quaternion();
const _err = new THREE.Vector3();
const _com = new THREE.Vector3();
const _prevCom = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);

function rotationVector(q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-5) return out.set(0, 0, 0);
  const angle = 2 * Math.acos(Math.min(1, w));
  const k = angle / s;
  return out.set(x * k, y * k, z * k);
}

function clampAbs(v: number, max: number): number {
  return v > max ? max : v < -max ? -max : v;
}
function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

export class LocomotionController {
  private readonly rag: Ragdoll;
  private readonly physics: PhysicsWorld;

  private readonly legs: Leg[] = [
    { side: "L", hip: "hipL", knee: "kneeL", ankle: "ankleL", foot: "footL", planted: true, lock: null, anchor: new THREE.Vector3() },
    { side: "R", hip: "hipR", knee: "kneeR", ankle: "ankleR", foot: "footR", planted: true, lock: null, anchor: new THREE.Vector3() },
  ];

  active = false;
  /** "idle" = stand & balance in place; "walk" = step forward at `desiredSpeed`. */
  mode: "idle" | "walk" = "idle";
  desiredSpeed = 0; // m/s forward (+Z)

  // --- balance assist (root stabilization) ---
  assist = 1.0; // master 0..1 (1 = full training wheels)
  uprightKp = 240;
  uprightKd = 34;
  comKp = 28;
  comKd = 12;
  heightKp = 170; // strong: the height hold carries the body weight while legs articulate
  heightKd = 28;
  targetHeight = 0.95; // standing pelvis height
  walkHeight = 0.9; // crouch a touch when walking so a swung-forward leg can reach the ground
  walkDrive = 8; // forward velocity-servo gain (m/s² per m/s of speed error)
  walkLean = 0.25; // forward pitch (rad) of the trunk while walking — lean into the stride
  maxAssistTorque = 90;
  maxAssistForce = 300;

  // --- gait ---
  stepDur = 0.44; // seconds per step
  strideAmp = 0.55; // hip swing amplitude (rad) at full speed
  liftAmp = 0.95; // knee flex at mid-swing (rad)
  legStiffness = 1.0; // stance/swing leg muscle stiffness
  stanceHipFollow = 0.35; // stance hip stiffness fraction (compliant so pelvis pivots)

  private swing: Side = "R";
  private phaseTime = 0;
  private totalMass = 0;
  private comVel = new THREE.Vector3();

  constructor(rag: Ragdoll, physics: PhysicsWorld) {
    this.rag = rag;
    this.physics = physics;
    this.totalMass = rag.spec.bones.reduce((s, b) => s + b.mass, 0);
  }

  // --- lifecycle ------------------------------------------------------------

  /** Stand the ragdoll up: reset to rest pose, unpin the chest, plant both feet. */
  activate(): void {
    for (const leg of this.legs) this.liftFoot(leg);
    this.rag.reset();
    this.rag.setAnchorPinned(false);
    this.swing = "R";
    this.phaseTime = 0;
    this.mode = "idle";
    this.active = true;
    this.rag.getCOM(_prevCom);
    this.comVel.set(0, 0, 0);
    for (const leg of this.legs) this.plantFoot(leg);
    this.applyStandPose();
  }

  /** Hand control back (e.g. the hang demo): drop foot-locks. */
  deactivate(): void {
    for (const leg of this.legs) this.liftFoot(leg);
    this.active = false;
  }

  setMode(m: "idle" | "walk"): void {
    if (m === this.mode) return;
    this.mode = m;
    this.phaseTime = 0;
    if (m === "walk" && this.legs.every((l) => l.planted)) {
      // lift the chosen swing leg to start the cycle
      this.liftFoot(this.leg(this.swing));
    }
  }

  // --- per-frame gait (FSM + IK-free angle curves) --------------------------

  /** Once per physics frame: advance the gait, set leg muscle targets, manage foot-locks. */
  tick(frameDt: number): void {
    if (!this.active) return;

    // COM velocity estimate (frame rate) for the balance assist.
    this.rag.getCOM(_com);
    this.comVel.subVectors(_com, _prevCom).multiplyScalar(1 / Math.max(1e-4, frameDt));
    _prevCom.copy(_com);

    if (this.mode === "idle" || this.desiredSpeed <= 0.001) {
      this.applyStandPose();
      return;
    }

    // Step timing scales mildly with speed (faster = quicker cadence).
    const dur = this.stepDur / (1 + 0.5 * Math.min(2, this.desiredSpeed));
    this.phaseTime += frameDt;
    if (this.phaseTime >= dur) {
      this.phaseTime -= dur;
      this.plantFoot(this.leg(this.swing)); // plant the leg that was swinging
      this.swing = this.swing === "L" ? "R" : "L"; // switch
      this.liftFoot(this.leg(this.swing)); // lift the new swing leg
    }
    const p = this.phaseTime / dur; // 0..1 within the current swing

    const amp = this.strideAmp * Math.min(1, this.desiredSpeed / 1.6);
    const pose: Record<string, THREE.Quaternion> = {};

    for (const leg of this.legs) {
      if (leg.side === this.swing) {
        // Swing leg: hip rotates from extended-behind (+amp) to flexed-front (-amp);
        // about +X, -pitch moves the foot toward +Z (forward). Knee flexes mid-swing
        // to clear the ground (sin bump), straight at the ends to plant.
        const hipPitch = THREE.MathUtils.lerp(amp, -amp, smoothstep(p));
        const kneeFlex = this.liftAmp * Math.sin(Math.PI * p);
        pose[leg.hip] = _q.setFromAxisAngle(_X, hipPitch).clone();
        pose[leg.knee] = new THREE.Quaternion().setFromAxisAngle(_X, kneeFlex);
        pose[leg.ankle] = new THREE.Quaternion(); // flat
        this.rag.setJointStiffness(leg.hip, this.legStiffness);
        this.rag.setJointStiffness(leg.knee, this.legStiffness);
        this.rag.setJointStiffness(leg.ankle, this.legStiffness * 0.7);
      } else {
        // Stance leg: knee stiff & straight (supporting strut), hip compliant so the
        // pelvis can travel forward over the locked foot, ankle holds flat.
        pose[leg.hip] = new THREE.Quaternion();
        pose[leg.knee] = new THREE.Quaternion();
        pose[leg.ankle] = new THREE.Quaternion();
        this.rag.setJointStiffness(leg.hip, this.legStiffness * this.stanceHipFollow);
        this.rag.setJointStiffness(leg.knee, this.legStiffness);
        this.rag.setJointStiffness(leg.ankle, this.legStiffness * 0.7);
      }
    }
    this.rag.setTargetPose(pose);
  }

  /** Standing pose: both legs straight & stiff, feet planted. */
  private applyStandPose(): void {
    const pose: Record<string, THREE.Quaternion> = {};
    for (const leg of this.legs) {
      pose[leg.hip] = new THREE.Quaternion();
      pose[leg.knee] = new THREE.Quaternion();
      pose[leg.ankle] = new THREE.Quaternion();
      this.rag.setJointStiffness(leg.hip, this.legStiffness);
      this.rag.setJointStiffness(leg.knee, this.legStiffness);
      this.rag.setJointStiffness(leg.ankle, this.legStiffness * 0.8);
      if (!leg.planted) this.plantFoot(leg);
    }
    this.rag.setTargetPose(pose);
  }

  // --- per-substep balance assist ------------------------------------------

  /** Per physics substep: keep the trunk upright and the COM over the support feet. */
  applyAssist(dt: number): void {
    if (!this.active || this.assist <= 0) return;
    const a = this.assist;

    // Upright PD torque on pelvis & chest toward the target trunk orientation. While
    // walking the target leans forward by `walkLean` so the body falls into the stride
    // and vaults over the locked stance foot (a bolt-upright target can't walk).
    const walkingNow = this.mode === "walk" && this.desiredSpeed > 0.001;
    _qTarget.identity();
    if (walkingNow) _qTarget.setFromAxisAngle(_X, -this.walkLean); // -X pitch = lean toward +Z
    for (const name of ["pelvis", "chest"]) {
      const b = this.rag.body(name);
      const r = b.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      _qInv.copy(_q).invert();
      _qErrT.copy(_qTarget).multiply(_qInv); // error from current to target
      rotationVector(_qErrT, _err);
      const w = b.angvel();
      const I = this.rag.inertiaMean(name);
      const k = this.uprightKp, kd = this.uprightKd;
      const tx = clampAbs((_err.x * k - w.x * kd) * I * a * dt, this.maxAssistTorque);
      const ty = clampAbs((_err.y * k - w.y * kd) * I * a * dt, this.maxAssistTorque);
      const tz = clampAbs((_err.z * k - w.z * kd) * I * a * dt, this.maxAssistTorque);
      b.applyTorqueImpulse({ x: tx, y: ty, z: tz }, true);
    }

    // Horizontal: keep COM over support, drive it toward desired forward speed.
    this.rag.getCOM(_com);
    let sx = 0, sz = 0, n = 0;
    for (const leg of this.legs) {
      if (!leg.planted) continue;
      const ft = this.rag.body(leg.foot).translation();
      sx += ft.x; sz += ft.z; n++;
    }
    if (n === 0) { sx = _com.x; sz = _com.z; n = 1; }
    sx /= n; sz /= n;
    const walking = this.mode === "walk" && this.desiredSpeed > 0.001;
    // Lateral (x): always keep the COM centred over the support feet.
    const fx = (this.comKp * (sx - _com.x) - this.comKd * this.comVel.x) * this.totalMass;
    // Travel (z): standing -> centre over support; walking -> velocity servo toward the
    // desired forward speed (lets the body lean into the step instead of being pinned back).
    const fz = walking
      ? this.walkDrive * (this.desiredSpeed - this.comVel.z) * this.totalMass
      : (this.comKp * (sz - _com.z) - this.comKd * this.comVel.z) * this.totalMass;
    const pelvis = this.rag.body("pelvis");
    pelvis.applyImpulse(
      { x: clampAbs(fx * a * dt, this.maxAssistForce), y: 0, z: clampAbs(fz * a * dt, this.maxAssistForce) },
      true,
    );

    // Vertical: hold pelvis height (push up only). Crouch slightly while walking.
    const pt = pelvis.translation();
    const pv = pelvis.linvel();
    const hTarget = walking ? this.walkHeight : this.targetHeight;
    let fy = (this.heightKp * (hTarget - pt.y) - this.heightKd * pv.y) * this.totalMass;
    if (fy < 0) fy = 0;
    pelvis.applyImpulse({ x: 0, y: clampAbs(fy * a * dt, this.maxAssistForce), z: 0 }, true);
  }

  // --- foot-lock ------------------------------------------------------------

  private plantFoot(leg: Leg): void {
    if (leg.lock) return;
    const foot = this.rag.body(leg.foot);
    const ft = foot.translation();
    // Pin the foot centre to the ground at its current X/Z (anchor Y at ground contact so
    // it plants on the floor, not in mid-air — the lock pulls the leg down into a stance).
    const data = this.physics.rapier.JointData.spherical(
      { x: 0, y: 0, z: 0 },
      { x: ft.x, y: 0.05, z: ft.z },
    );
    leg.lock = this.physics.world.createImpulseJoint(data, foot, this.physics.groundBody, true);
    leg.anchor.set(ft.x, 0.05, ft.z);
    leg.planted = true;
  }

  private liftFoot(leg: Leg): void {
    if (leg.lock) {
      this.physics.world.removeImpulseJoint(leg.lock, true);
      leg.lock = null;
    }
    leg.planted = false;
  }

  private leg(side: Side): Leg {
    return side === "L" ? this.legs[0] : this.legs[1];
  }

  // --- debug read-out -------------------------------------------------------

  debugState(): { planted: string; swing: Side; comY: number; pelvisY: number } {
    return {
      planted: this.legs.filter((l) => l.planted).map((l) => l.side).join("+") || "none",
      swing: this.swing,
      comY: this.rag.getCOM(_v).y,
      pelvisY: this.rag.body("pelvis").translation().y,
    };
  }

  /** Live metrics for the on-screen HUD (read each frame). */
  hud(): {
    mode: string; targetSpeed: number; speed: number; pelvisY: number; comY: number;
    tip: number; assist: number; legs: { side: Side; planted: boolean; slipMm: number }[];
  } {
    this.rag.getCOM(_v);
    // Support centre (planted feet) and COM horizontal offset from it = how close to tipping.
    let sx = 0, sz = 0, n = 0;
    for (const leg of this.legs) {
      if (!leg.planted) continue;
      const ft = this.rag.body(leg.foot).translation();
      sx += ft.x; sz += ft.z; n++;
    }
    // Lateral (side-to-side) COM offset from support = real fall risk. Forward offset is
    // intentional lean during a walk, so it's excluded here.
    const tip = n > 0 ? Math.abs(_v.x - sx / n) : 0;
    return {
      mode: this.mode,
      targetSpeed: this.desiredSpeed,
      speed: this.comVel.z,
      pelvisY: this.rag.body("pelvis").translation().y,
      comY: _v.y,
      tip,
      assist: this.assist,
      legs: this.legs.map((l) => {
        const ft = this.rag.body(l.foot).translation();
        const slip = l.planted ? Math.hypot(ft.x - l.anchor.x, ft.z - l.anchor.z) : 0;
        return { side: l.side, planted: l.planted, slipMm: slip * 1000 };
      }),
    };
  }
}
