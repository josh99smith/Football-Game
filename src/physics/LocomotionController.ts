import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { PhysicsWorld } from "./PhysicsWorld";
import type { Ragdoll } from "./Ragdoll";
import { type GaitTuning, defaultGait, armFlex, elbowFlex, spineLean } from "./GaitReference";

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
const _Y = new THREE.Vector3(0, 1, 0);
const _Z = new THREE.Vector3(0, 0, 1);
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _fk = new THREE.Vector3();
const _hipQ = new THREE.Quaternion();
const _pelvisPos = new THREE.Vector3();
const _pelvisQ = new THREE.Quaternion();
const _pelvisQInv = new THREE.Quaternion();
const _targetL = new THREE.Vector3();
const _hipW = new THREE.Vector3();
const _targetW = new THREE.Vector3();

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
  uprightKp = 800; // strong: holds the trunk near-vertical against the forward drive (no lurch)
  uprightKd = 70;
  comKp = 28;
  comKd = 12;
  heightKp = 170; // strong: the height hold carries the body weight while legs articulate
  heightKd = 28;
  targetHeight = 0.95; // standing pelvis height
  walkHeight = 0.9; // crouch a touch when walking so a swung-forward leg can reach the ground
  walkDrive = 6; // forward velocity-servo (applied pitch-free at the chest) — drives root speed
  walkLean = 0.25; // forward pitch (rad) of the trunk while walking — lean into the stride
  maxAssistTorque = 220; // headroom for the strong upright hold
  maxAssistForce = 300;

  // --- gait (reference-tracking: a clinical gait cycle the muscles PD-track) ---
  gait: GaitTuning = { ...defaultGait };
  cycleTime = 1.15; // seconds per full gait cycle (two steps) at speed ~1; quickens with speed
  stanceFrac = 0.62; // fraction of a leg's cycle spent in stance (rest is swing)
  pushoff = 0; // (off) a root impulse here catapults at resonant cadences; the ankle rolls instead
  stepHeight = 0.16; // swing-foot lift to clear the ground (m)
  anklePush = 0.22; // terminal-stance plantarflexion (rad ~13°) — toe-off foot roll + mild push
  heelStrike = 0.18; // swing-foot dorsiflexion (rad ~10°) approaching contact — land heel-first
  loadDip = 0.12; // loading-response stance-knee flex (rad) just after heel-strike
  comBob = 0.035; // vertical COM oscillation amplitude (m) — rises at passing, drops at stride
  pelvisYaw = 0.09; // transverse pelvis rotation amplitude (rad ~5°) — the walking twist
  thoraxYaw = 0.11; // counter-rotation of the thorax (rad ~6°), opposite the pelvis
  stepAhead = 0.30; // baseline foot plant AHEAD of the COM (m) — the front-leg reach of a
  // proper stride (with the trailing leg extending behind, this gives the wide contact split)
  captureGain = 0.12; // capture-point feedback: plant further out when the COM is moving fast
  legStiffness = 1.0; // swing/stance leg muscle stiffness
  armStiffness = 0.8; // arm-swing muscle stiffness (high enough that the arms actually track)
  shoulderAbduct = 0.14; // constant arm abduction (rad ~8°) so arms clear the torso
  stanceBend = 0.02; // near-straight: the support leg straightens at passing to lift the body

  private phase = 0; // global gait phase [0,1); right leg = phase, left = phase+0.5
  private totalMass = 0;
  private comVel = new THREE.Vector3();
  private ikErr = 0; // stance-leg IK residual (correctness read-out)
  private readonly _g: GaitTuning = { ...defaultGait }; // speed-scaled working copy
  private readonly liftoff = new THREE.Vector3(); // swing foot world pos at toe-off

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
    this.phase = 0;
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
    // Start the cycle at heel-strike of the right leg (right in stance, left about to push
    // off) so the very first move is a clean step rather than a lurch.
    if (m === "walk") this.phase = 0;
  }

  // --- per-frame gait (reference-tracking + no-slip stance + arm swing) -----

  private readonly pose: Record<string, THREE.Quaternion> = {};

  /** Once per physics frame: advance the gait phase, set muscle targets from the reference,
   * keep the stance leg on its lock, swing the arms, manage foot-locks. */
  tick(frameDt: number): void {
    if (!this.active) return;

    // Pelvis frame (for the stance-leg IK) + COM velocity (for the balance assist).
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

    // Advance the cycle — cadence quickens and stride grows with speed.
    const speedF = clamp(0.7 + 0.55 * this.desiredSpeed, 0.7, 2.4);
    this.phase = (this.phase + frameDt / (this.cycleTime / speedF)) % 1;
    const amp = clamp(0.55 + 0.5 * this.desiredSpeed, 0.55, 1.7);
    // Speed-scaled working copy of the gait tuning (bigger stride/lift/arms when faster).
    const g = this._g, base = this.gait;
    g.hipAmp = base.hipAmp * amp;
    g.hipBias = base.hipBias;
    g.kneeStance = base.kneeStance;
    g.kneeSwing = base.kneeSwing * (0.7 + 0.3 * amp);
    g.kneeBase = base.kneeBase;
    g.anklePush = base.anklePush;
    g.ankleDorsi = base.ankleDorsi;
    g.armAmp = base.armAmp * amp;
    g.elbowBend = base.elbowBend;
    g.spineLean = base.spineLean;

    for (const leg of this.legs) {
      const phi = leg.side === "R" ? this.phase : (this.phase + 0.5) % 1;
      const stance = phi < this.stanceFrac;
      // Foot-lock follows the stance/swing schedule (plant at heel-strike, lift at toe-off).
      if (stance && !leg.planted) this.plantFoot(leg);
      else if (!stance && leg.planted) {
        const ft = this.rag.body(leg.foot).translation();
        this.liftoff.set(ft.x, ft.y, ft.z);
        this.liftFoot(leg);
        this.applyPushoff();
      }

      if (stance) {
        // IK-conform to the locked foot (no slip), with a foot-roll: controlled lowering
        // after heel-strike, then a terminal-stance plantarflexion push-off near toe-off.
        this.driveStance(leg, phi / this.stanceFrac);
      } else {
        // Swing: place the foot AHEAD of the COM (capture point) via IK, along a lifted arc
        // shaped by the reference; landing ahead keeps the COM behind support → upright.
        const swingProg = (phi - this.stanceFrac) / (1 - this.stanceFrac);
        this.driveSwing(leg, swingProg);
      }
    }
    this.driveArms(g);
    // Trunk: a small, deliberate forward lean from the reference (not the old 45° lurch).
    (this.pose.spine ??= new THREE.Quaternion()).setFromAxisAngle(_X, -spineLean(g));
    this.rag.setTargetPose(this.pose);
  }

  /** Swing leg: IK the foot along a lifted arc to a capture-point landing AHEAD of the COM.
   * The forward offset (stepAhead + speed/capture terms) is what keeps the COM behind the
   * support foot, so the body walks tall instead of falling forward over trailing feet. */
  private driveSwing(leg: Leg, prog: number): void {
    _hipW.copy(HIP_LOCAL[leg.side]).applyQuaternion(_pelvisQ).add(_pelvisPos);
    const ahead = this.stepAhead + 0.16 * this.desiredSpeed + this.captureGain * (this.comVel.z - this.desiredSpeed);
    const landX = _hipW.x + this.captureGain * this.comVel.x;
    const landZ = _com.z + Math.max(0.05, ahead);
    const s = prog * prog * (3 - 2 * prog); // smoothstep
    const ax = THREE.MathUtils.lerp(this.liftoff.x, landX, s);
    const az = THREE.MathUtils.lerp(this.liftoff.z, landZ, s);
    const ay = 0.06 + this.stepHeight * Math.sin(Math.PI * prog);
    _targetW.set(ax, ay, az);
    _targetL.copy(_targetW).sub(_pelvisPos).applyQuaternion(_pelvisQInv);
    const knee = legIK(HIP_LOCAL[leg.side], _targetL, _hipQ);
    // Heel-strike: dorsiflex the foot (toes up) over the back of the swing so it lands
    // heel-first, like the reference, instead of slapping down flat.
    const heel = this.heelStrike * smoothstep((prog - 0.6) / 0.4);
    (this.pose[leg.hip] ??= new THREE.Quaternion()).copy(_hipQ);
    (this.pose[leg.knee] ??= new THREE.Quaternion()).setFromAxisAngle(_X, knee);
    (this.pose[leg.ankle] ??= new THREE.Quaternion()).setFromAxisAngle(_X, heel);
    this.rag.setJointStiffness(leg.hip, this.legStiffness);
    this.rag.setJointStiffness(leg.knee, this.legStiffness);
    this.rag.setJointStiffness(leg.ankle, this.legStiffness * 0.6);
  }

  /** Stance leg: IK to its locked anchor so it supports and conforms (no slip) as the root is
   * driven forward over it. The ankle rolls through stance — neutral after heel-strike, then a
   * terminal-stance plantarflexion push-off (sp = stance progress 0→1) for propulsion + a
   * natural toe-off. The locked foot pivots freely, so the ankle drive levers the body up/fwd. */
  private driveStance(leg: Leg, sp: number): void {
    _targetL.copy(leg.anchor).add(_v.set(0, 0.01, 0)).sub(_pelvisPos).applyQuaternion(_pelvisQInv);
    // Loading-response dip: a brief extra knee flex just after heel-strike (shock absorption),
    // fading by midstance — adds the natural little sink onto the leading leg.
    const dip = this.loadDip * Math.exp(-(((sp - 0.12) / 0.16) ** 2));
    const knee = legIK(HIP_LOCAL[leg.side], _targetL, _hipQ) + this.stanceBend + dip;
    fkAnkle(HIP_LOCAL[leg.side], _hipQ, knee, _fk);
    this.ikErr = _fk.sub(_targetL).length();
    // Push-off: plantarflex over the back third of stance, ramped to full at toe-off.
    const roll = -this.anklePush * smoothstep((sp - 0.65) / 0.35);
    (this.pose[leg.hip] ??= new THREE.Quaternion()).copy(_hipQ);
    (this.pose[leg.knee] ??= new THREE.Quaternion()).setFromAxisAngle(_X, knee);
    (this.pose[leg.ankle] ??= new THREE.Quaternion()).setFromAxisAngle(_X, roll);
    this.rag.setJointStiffness(leg.hip, this.legStiffness);
    this.rag.setJointStiffness(leg.knee, this.legStiffness);
    this.rag.setJointStiffness(leg.ankle, this.legStiffness);
  }

  /** Contralateral arm swing from the reference (right arm back as the right leg swings up),
   * with a small constant abduction so the arms hang clear of the torso and the fore/aft
   * swing reads instead of clipping the body. */
  private driveArms(g: GaitTuning): void {
    const eb = elbowFlex(g);
    for (const side of ["R", "L"] as Side[]) {
      const phi = side === "R" ? this.phase : (this.phase + 0.5) % 1;
      const a = armFlex(phi, g);
      const sign = side === "R" ? 1 : -1;
      _qa.setFromAxisAngle(_Z, sign * this.shoulderAbduct); // abduction (out from the body)
      _qb.setFromAxisAngle(_X, -a); // fore/aft swing
      (this.pose[`shoulder${side}`] ??= new THREE.Quaternion()).copy(_qa).multiply(_qb);
      (this.pose[`elbow${side}`] ??= new THREE.Quaternion()).setFromAxisAngle(_X, -eb);
      this.rag.setJointStiffness(`shoulder${side}`, this.armStiffness);
      this.rag.setJointStiffness(`elbow${side}`, this.armStiffness);
    }
  }

  /** Toe-off: a forward+up momentum kick at the pelvis backing the reference's propulsion. */
  private applyPushoff(): void {
    if (this.pushoff <= 0) return;
    const j = this.totalMass * this.pushoff * Math.max(0.5, this.desiredSpeed);
    this.rag.body("pelvis").applyImpulse({ x: 0, y: j * 0.25, z: j }, true);
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

    // Upright PD torque on pelvis & chest — hold the trunk vertical, plus a transverse twist:
    // the pelvis rotates toward the swing side and the thorax counter-rotates the other way
    // (the natural walking twist that the arm swing pairs with). sTw oscillates once per cycle.
    const walking = this.mode === "walk" && this.desiredSpeed > 0.001;
    const sTw = walking ? Math.sin(this.phase * Math.PI * 2) : 0;
    for (const name of ["pelvis", "chest"]) {
      const yaw = name === "pelvis" ? this.pelvisYaw * sTw : -this.thoraxYaw * sTw;
      _qTarget.setFromAxisAngle(_Y, yaw);
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
    // Lateral (x): always keep the COM centred over the support feet.
    const fx = (this.comKp * (sx - _com.x) - this.comKd * this.comVel.x) * this.totalMass;
    // Travel (z): standing -> centre over support; walking -> velocity servo toward the
    // desired forward speed (lets the body lean into the step instead of being pinned back).
    const fz = walking
      ? this.walkDrive * (this.desiredSpeed - this.comVel.z) * this.totalMass
      : (this.comKp * (sz - _com.z) - this.comKd * this.comVel.z) * this.totalMass;
    const pelvis = this.rag.body("pelvis");
    // Lateral correction at the pelvis; forward drive split pelvis+chest so the horizontal
    // push doesn't act below the COM and pitch the trunk forward (the old lurch).
    const fzc = clampAbs(fz * a * dt, this.maxAssistForce);
    pelvis.applyImpulse({ x: clampAbs(fx * a * dt, this.maxAssistForce), y: 0, z: fzc * 0.4 }, true);
    this.rag.body("chest").applyImpulse({ x: 0, y: 0, z: fzc * 0.6 }, true);

    // Vertical: hold pelvis height (push up only), with a gait bob — the body rises toward
    // each midstance and dips through double-support (twice per cycle), the natural up-down.
    const pt = pelvis.translation();
    const pv = pelvis.linvel();
    const bob = walking ? this.comBob * (0.5 - 0.5 * Math.cos(4 * Math.PI * this.phase)) : 0;
    const hTarget = (walking ? this.walkHeight : this.targetHeight) + bob;
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

  // --- debug read-out -------------------------------------------------------

  debugState(): { planted: string; phase: number; comY: number; pelvisY: number } {
    return {
      planted: this.legs.filter((l) => l.planted).map((l) => l.side).join("+") || "none",
      phase: this.phase,
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
