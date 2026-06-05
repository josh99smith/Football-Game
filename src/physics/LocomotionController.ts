import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { PhysicsWorld } from "./PhysicsWorld";
import type { Ragdoll } from "./Ragdoll";

/**
 * Procedural locomotion + balance on top of the active ragdoll. No clips. The body is a
 * free dynamic ragdoll (chest unpinned); four things keep it upright and moving:
 *
 *  1. Foot-lock — a planted foot is pinned to the ground with a temporary spherical joint
 *     so it CANNOT slide (foot-slide is the non-negotiable bug); removed on lift.
 *  2. Capture-point foot placement — each step computes where the swing foot must LAND to
 *     stay balanced and hold the target speed (ahead of the COM by half a step's travel,
 *     pushed further the faster the COM is moving). This closed-loop placement, not a
 *     scripted angle curve, is what makes the gait balance and scale with speed.
 *  3. Leg IK — analytic 2-bone IK drives the swing foot along a lifted arc to that target
 *     and conforms the stance leg to its locked foot (so it supports without fighting the
 *     lock). Targets become hip/knee muscle angles for the PD "muscles" to track.
 *  4. Push-off + balance assist — a forward+up momentum kick at toe-off provides the
 *     propulsion; a root stabilization wrench (upright torque, COM-over-support, height
 *     hold) backs it up, on a single `assist` knob (1 = training wheels, 0 = pure muscle).
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
const _pelvisPos = new THREE.Vector3();
const _pelvisQ = new THREE.Quaternion();
const _pelvisQInv = new THREE.Quaternion();
const _hipW = new THREE.Vector3();
const _hipL = new THREE.Vector3();
const _targetW = new THREE.Vector3();
const _targetL = new THREE.Vector3();
const _fk = new THREE.Vector3();
const _hipQ = new THREE.Quaternion();
const _kneeQ = new THREE.Quaternion();

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
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function smoothstep(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// --- leg geometry (pelvis-local, from the ragdoll rest spec) ---
const L1 = 0.42; // thigh: hip pivot (y 0.85) -> knee pivot (y 0.43)
const L2 = 0.37; // shin:  knee pivot (y 0.43) -> ankle pivot (y 0.06)
// Hip pivot relative to pelvis CENTRE (pelvis centre y 0.95, hip pivot y 0.85, x ±0.1).
const HIP_LOCAL: Record<Side, THREE.Vector3> = {
  L: new THREE.Vector3(-0.1, -0.1, 0),
  R: new THREE.Vector3(0.1, -0.1, 0),
};
const _FWD = new THREE.Vector3(0, 0, 1);
const _u = new THREE.Vector3();
const _right = new THREE.Vector3();
const _thigh = new THREE.Vector3();
const _yCol = new THREE.Vector3();
const _zCol = new THREE.Vector3();
const _xCol = new THREE.Vector3();
const _m4 = new THREE.Matrix4();

/**
 * Analytic 2-bone leg IK in the pelvis frame. Given the hip pivot and a desired ankle
 * position (both pelvis-local), solve the hip orientation (thigh relative to pelvis) and
 * the knee flexion angle so the ankle reaches the target with the knee pointing forward.
 * Returns the knee flex (rad); writes the hip quaternion into `hipOut`.
 */
function legIK(hip: THREE.Vector3, target: THREE.Vector3, hipOut: THREE.Quaternion): number {
  _u.subVectors(target, hip);
  let d = _u.length();
  d = clamp(d, Math.abs(L1 - L2) + 0.02, L1 + L2 - 0.02);
  _u.normalize();
  // Knee flex: 0 = straight, grows as the foot tucks under the hip.
  const cosK = clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1);
  const knee = Math.PI - Math.acos(cosK);
  // Angle between the hip→ankle line and the thigh.
  const beta = Math.acos(clamp((d * d + L1 * L1 - L2 * L2) / (2 * d * L1), -1, 1));
  // Hinge axis (knee points forward): perpendicular to the leg line and forward.
  _right.crossVectors(_FWD, _u);
  if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0); else _right.normalize();
  // Thigh direction = leg line rotated by -beta about the hinge, bulging the knee forward
  // (+beta would throw the knee backward and the foot would never reach the target).
  _thigh.copy(_u).applyAxisAngle(_right, -beta);
  // Build the thigh orientation: local -Y (down the bone) -> thighDir, local +X -> hinge.
  _yCol.copy(_thigh).multiplyScalar(-1); // image of local +Y
  _zCol.crossVectors(_right, _yCol).normalize();
  _xCol.crossVectors(_yCol, _zCol).normalize();
  _m4.makeBasis(_xCol, _yCol, _zCol);
  hipOut.setFromRotationMatrix(_m4);
  return knee;
}

/** Forward-kinematics ankle position for an IK solution (to measure the solver residual). */
function fkAnkle(hip: THREE.Vector3, hipQ: THREE.Quaternion, knee: number, out: THREE.Vector3): THREE.Vector3 {
  const kneePos = out.set(0, -L1, 0).applyQuaternion(hipQ).add(hip);
  const shin = _u.set(0, -L2, 0).applyAxisAngle(_X, knee).applyQuaternion(hipQ);
  return out.copy(kneePos).add(shin);
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
  walkDrive = 4; // residual forward velocity-servo (push-off does most of the propulsion now)
  walkLean = 0.25; // forward pitch (rad) of the trunk while walking — lean into the stride
  maxAssistTorque = 90;
  maxAssistForce = 300;

  // --- gait (closed-loop: capture-point foot placement + leg IK + push-off) ---
  stepDur = 0.42; // seconds per step at low speed (cadence quickens with speed)
  stepHeight = 0.14; // how high the swing foot lifts to clear the ground (m)
  captureGain = 0.10; // capture-point feedback: foot lands further ahead when COM is fast
  pushoff = 0.55; // toe-off impulse at lift (m/s of forward+up kick injected at the pelvis)
  legStiffness = 1.0; // leg muscle stiffness (swing + stance)
  stanceBend = 0.06; // slight stance-knee bend target offset for a sprung, non-locked look

  private swing: Side = "R";
  private phaseTime = 0;
  private totalMass = 0;
  private comVel = new THREE.Vector3();
  private readonly liftoff = new THREE.Vector3(); // swing foot world pos at toe-off
  private ikErr = 0; // FK residual of the last swing IK solve (correctness read-out)

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

  // --- per-frame gait (capture-point foot placement + leg IK + push-off) ----

  private readonly pose: Record<string, THREE.Quaternion> = {};

  /** Once per physics frame: advance the gait, set leg muscle targets, manage foot-locks. */
  tick(frameDt: number): void {
    if (!this.active) return;

    // Pelvis frame + COM velocity (frame-rate estimate) for placement and balance.
    const pp = this.rag.body("pelvis").translation();
    const pr = this.rag.body("pelvis").rotation();
    _pelvisPos.set(pp.x, pp.y, pp.z);
    _pelvisQ.set(pr.x, pr.y, pr.z, pr.w);
    _pelvisQInv.copy(_pelvisQ).invert();
    this.rag.getCOM(_com);
    this.comVel.subVectors(_com, _prevCom).multiplyScalar(1 / Math.max(1e-4, frameDt));
    _prevCom.copy(_com);

    if (this.mode === "idle" || this.desiredSpeed <= 0.001) {
      this.applyStandPose();
      return;
    }

    // Cadence quickens with speed; step length then comes from capture-point placement.
    const dur = this.stepDur / (1 + 0.45 * Math.min(2.5, this.desiredSpeed));
    this.phaseTime += frameDt;
    if (this.phaseTime >= dur) {
      this.phaseTime -= dur;
      this.plantFoot(this.leg(this.swing)); // the swinging leg lands and locks
      this.swing = this.swing === "L" ? "R" : "L";
      const next = this.leg(this.swing);
      const ft = this.rag.body(next.foot).translation();
      this.liftoff.set(ft.x, ft.y, ft.z); // record toe-off position for the swing arc
      this.liftFoot(next);
      this.applyPushoff(); // inject forward+up momentum at toe-off
    }
    const p = this.phaseTime / dur; // 0..1 within the current swing

    for (const leg of this.legs) {
      if (leg.side === this.swing) {
        this.driveSwing(leg, p);
      } else {
        this.driveStance(leg);
      }
    }
    this.rag.setTargetPose(this.pose);
  }

  /** Swing leg: IK the foot along a lifted arc to the capture-point landing target. */
  private driveSwing(leg: Leg, p: number): void {
    // Capture-point landing: ahead of the COM by half a step's travel, pushed further
    // when the COM is moving faster than desired (and pulled in laterally toward the hip).
    _hipL.copy(HIP_LOCAL[leg.side]);
    _hipW.copy(_hipL).applyQuaternion(_pelvisQ).add(_pelvisPos); // hip pivot, world
    const half = this.desiredSpeed * (this.stepDur * 0.5);
    const landX = _hipW.x + this.captureGain * this.comVel.x;
    const landZ = _com.z + half + this.captureGain * (this.comVel.z - this.desiredSpeed);
    // Arc: lerp horizontally from toe-off to the target, lift vertically with a sine bump.
    const s = smoothstep(p);
    const ax = THREE.MathUtils.lerp(this.liftoff.x, landX, s);
    const az = THREE.MathUtils.lerp(this.liftoff.z, landZ, s);
    const ay = 0.06 + this.stepHeight * Math.sin(Math.PI * p);
    _targetW.set(ax, ay, az);
    this.solveLeg(leg, _targetW, true);
  }

  /** Stance leg: IK to its own locked anchor so the leg conforms (and supports) as the
   * pelvis travels over it, instead of a stiff target fighting the foot-lock. */
  private driveStance(leg: Leg): void {
    _targetW.copy(leg.anchor);
    _targetW.y += 0.01;
    this.solveLeg(leg, _targetW, false);
  }

  /** Shared: world ankle target -> pelvis-frame IK -> hip/knee/ankle muscle targets. */
  private solveLeg(leg: Leg, targetWorld: THREE.Vector3, isSwing: boolean): void {
    _targetL.copy(targetWorld).sub(_pelvisPos).applyQuaternion(_pelvisQInv); // pelvis-local
    const knee = legIK(HIP_LOCAL[leg.side], _targetL, _hipQ) + (isSwing ? 0 : this.stanceBend);
    if (isSwing) {
      fkAnkle(HIP_LOCAL[leg.side], _hipQ, knee, _fk);
      this.ikErr = _fk.sub(_targetL).length();
    }
    (this.pose[leg.hip] ??= new THREE.Quaternion()).copy(_hipQ);
    (this.pose[leg.knee] ??= new THREE.Quaternion()).copy(_kneeQ.setFromAxisAngle(_X, knee));
    (this.pose[leg.ankle] ??= new THREE.Quaternion()).identity(); // foot flat relative to shin
    this.rag.setJointStiffness(leg.hip, this.legStiffness);
    this.rag.setJointStiffness(leg.knee, this.legStiffness);
    this.rag.setJointStiffness(leg.ankle, this.legStiffness * 0.7);
  }

  /** Toe-off: inject a forward+up momentum kick at the pelvis (the missing propulsion). */
  private applyPushoff(): void {
    if (this.pushoff <= 0) return;
    const j = this.totalMass * this.pushoff * Math.max(0.4, this.desiredSpeed);
    this.rag.body("pelvis").applyImpulse({ x: 0, y: j * 0.3, z: j }, true);
  }

  /** Standing pose: both legs straight & stiff, feet planted. */
  private applyStandPose(): void {
    for (const leg of this.legs) {
      (this.pose[leg.hip] ??= new THREE.Quaternion()).identity();
      (this.pose[leg.knee] ??= new THREE.Quaternion()).identity();
      (this.pose[leg.ankle] ??= new THREE.Quaternion()).identity();
      this.rag.setJointStiffness(leg.hip, this.legStiffness);
      this.rag.setJointStiffness(leg.knee, this.legStiffness);
      this.rag.setJointStiffness(leg.ankle, this.legStiffness * 0.8);
      if (!leg.planted) this.plantFoot(leg);
    }
    this.rag.setTargetPose(this.pose);
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

  /** Debug: IK self-test — solve for a pelvis-local ankle target and return the FK residual. */
  ikTest(x: number, y: number, z: number): { knee: number; residual: number; ankle: number[] } {
    const t = new THREE.Vector3(x, y, z);
    const knee = legIK(HIP_LOCAL.R, t, _hipQ);
    fkAnkle(HIP_LOCAL.R, _hipQ, knee, _fk);
    return { knee, residual: _fk.distanceTo(t), ankle: [_fk.x, _fk.y, _fk.z] };
  }

  /** Live metrics for the on-screen HUD (read each frame). */
  hud(): {
    mode: string; targetSpeed: number; speed: number; pelvisY: number; comY: number;
    tip: number; assist: number; ikErr: number; legs: { side: Side; planted: boolean; slipMm: number }[];
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
      ikErr: this.ikErr,
      legs: this.legs.map((l) => {
        const ft = this.rag.body(l.foot).translation();
        const slip = l.planted ? Math.hypot(ft.x - l.anchor.x, ft.z - l.anchor.z) : 0;
        return { side: l.side, planted: l.planted, slipMm: slip * 1000 };
      }),
    };
  }
}
