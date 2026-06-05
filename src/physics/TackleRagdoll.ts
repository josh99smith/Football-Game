import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { PhysicsWorld } from "./PhysicsWorld";

/**
 * A passive (limp) ragdoll built to MATCH a live mixamorig skeleton, used for physics
 * tackles: when a player is hit, we snapshot the current animated pose, spawn this ragdoll
 * at it with the player's momentum + the tackle impulse, let physics play the fall, and
 * drive the skinned mesh's bones from the rigid bodies. Every tackle is then unique and
 * reactive — the thing a canned tackle clip can never be.
 *
 * It is deliberately passive (no muscles): a hit should go limp and fall under gravity +
 * contact. Segments are capsules between bone joints, linked by spherical joints; light
 * angular damping keeps it from flailing. Self-collision is off (avoids jitter); it collides
 * with the ground.
 */

const MIX = "mixamorig";
// Collision groups are computed per spawn (see `spawn`): each ragdoll collides with the
// ground and itself (self-collision stops limbs melting through the torso) but not other
// ragdolls. Adjacent (jointed) segments overlap at the shared joint, so we disable contacts
// on each joint to avoid a spawn explosion.

interface SegDef {
  name: string;
  top: string; // bone at the segment's parent-end (the joint to the parent)
  bot: string; // bone at the far end (defines length + direction)
  drives: string; // which bone this body's orientation drives
  parent: string | null;
  r: number; // capsule radius (m)
  m: number; // mass (kg)
  sw?: number; // soft swing (cone) limit vs parent, radians — how far it can bend from rest
  tw?: number; // soft twist limit about the bone axis, radians — stops the candy-wrapper
  fixed?: boolean; // weld rigidly to the parent (wrists/ankles: no twist -> no skin pinch)
}

// Major segments of the body, parents before children (drive order depends on it).
// sw/tw are the joint's soft range; beyond them a spring pushes back (see applyLimits).
const SEGS: SegDef[] = [
  { name: "pelvis", top: "Hips", bot: "Spine1", drives: "Hips", parent: null, r: 0.15, m: 12 },
  { name: "torso", top: "Spine1", bot: "Neck", drives: "Spine1", parent: "pelvis", r: 0.16, m: 16, sw: 0.55, tw: 0.5 },
  { name: "head", top: "Neck", bot: "HeadTop_End", drives: "Neck", parent: "torso", r: 0.11, m: 4.5, sw: 0.7, tw: 0.6 },
  { name: "thighL", top: "LeftUpLeg", bot: "LeftLeg", drives: "LeftUpLeg", parent: "pelvis", r: 0.085, m: 7, sw: 1.2, tw: 0.5 },
  { name: "shinL", top: "LeftLeg", bot: "LeftFoot", drives: "LeftLeg", parent: "thighL", r: 0.06, m: 4, sw: 1.4, tw: 0.25 },
  { name: "footL", top: "LeftFoot", bot: "LeftToe_End", drives: "LeftFoot", parent: "shinL", r: 0.05, m: 1, fixed: true },
  { name: "thighR", top: "RightUpLeg", bot: "RightLeg", drives: "RightUpLeg", parent: "pelvis", r: 0.085, m: 7, sw: 1.2, tw: 0.5 },
  { name: "shinR", top: "RightLeg", bot: "RightFoot", drives: "RightLeg", parent: "thighR", r: 0.06, m: 4, sw: 1.4, tw: 0.25 },
  { name: "footR", top: "RightFoot", bot: "RightToe_End", drives: "RightFoot", parent: "shinR", r: 0.05, m: 1, fixed: true },
  // Forearms end at the wrist; the hands get their own bodies (below) so they collide with
  // the ground instead of poking through it.
  { name: "uarmL", top: "LeftArm", bot: "LeftForeArm", drives: "LeftArm", parent: "torso", r: 0.05, m: 2.5, sw: 1.5, tw: 0.7 },
  { name: "farmL", top: "LeftForeArm", bot: "LeftHand", drives: "LeftForeArm", parent: "uarmL", r: 0.045, m: 1.5, sw: 1.6, tw: 0.3 },
  { name: "uarmR", top: "RightArm", bot: "RightForeArm", drives: "RightArm", parent: "torso", r: 0.05, m: 2.5, sw: 1.5, tw: 0.7 },
  { name: "farmR", top: "RightForeArm", bot: "RightHand", drives: "RightForeArm", parent: "uarmR", r: 0.045, m: 1.5, sw: 1.6, tw: 0.3 },
  { name: "handL", top: "LeftHand", bot: "LeftHandMiddle3", drives: "LeftHand", parent: "farmL", r: 0.04, m: 0.5, fixed: true },
  { name: "handR", top: "RightHand", bot: "RightHandMiddle3", drives: "RightHand", parent: "farmR", r: 0.04, m: 0.5, fixed: true },
];

interface Seg extends SegDef {
  body: RAPIER.RigidBody;
  center: THREE.Vector3; // world center at spawn
  qOffset: THREE.Quaternion; // bodyWorldQ^-1 * boneWorldQ at spawn (drive: boneWorldQ = bodyQ * qOffset)
  posOffset: THREE.Vector3; // bodyQ^-1 * (boneWorldPos - bodyWorldPos)
  driveBone: THREE.Bone; // primary instance (for spawn-time reads)
  driveBones: THREE.Bone[]; // every instance to drive (one per skeleton)
  parentSeg: Seg | null;
  qRelRest: THREE.Quaternion; // parentBodyQ^-1 * bodyQ at spawn (the joint's neutral pose)
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _wp = new THREE.Vector3();
const _wp2 = new THREE.Vector3();
const _upVel = new THREE.Vector3();
const _midVel = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);
// scratch for applyLimits (per-substep, kept separate from spawn/drive temps)
const _lpQ = new THREE.Quaternion();
const _lcQ = new THREE.Quaternion();
const _ltmp = new THREE.Quaternion();
const _lrel = new THREE.Quaternion();
const _ldev = new THREE.Quaternion();
const _ltwistInv = new THREE.Quaternion();
const _lswing = new THREE.Quaternion();
const _lrest = new THREE.Quaternion();
const _ltorque = new THREE.Vector3();

const LOWER = new Set(["thighL", "shinL", "footL", "thighR", "shinR", "footR"]);
const MAX_SPIN = 16; // rad/s — clamp so a body can never spin up into a contorted blur

export class TackleRagdoll {
  active = false;
  private readonly physics: PhysicsWorld;
  private segs: Seg[] = [];
  // The model is several SkinnedMeshes (arms/body/face/helmet…), each with its OWN skeleton
  // that REUSES the mixamo bone names. So a name maps to MULTIPLE bone instances and we must
  // drive every one of them identically, or one mesh's limb follows physics while another's
  // (e.g. the hand's fingers) stays frozen and tears off.
  private bones = new Map<string, THREE.Bone[]>();
  private prevSubsteps = 2;
  private age = 0; // seconds since spawn — limits fade out as this grows
  private groups = 0x00020003; // collision membership|filter, set per spawn (see spawn)

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
  }

  /** Collect every bone instance, grouped by short name (mixamorig prefix stripped). */
  bind(root: THREE.Object3D): void {
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone && o.name.startsWith(MIX)) {
        const key = o.name.slice(MIX.length);
        const list = this.bones.get(key);
        if (list) list.push(o as THREE.Bone);
        else this.bones.set(key, [o as THREE.Bone]);
      }
    });
  }

  /** Public lookup of the primary bone instance by short (prefix-stripped) name. */
  getBone(short: string): THREE.Bone | undefined {
    return this.bones.get(short)?.[0];
  }

  /** All bone instances sharing a short name (one per skeleton that contains it). */
  private boneList(short: string): THREE.Bone[] {
    const b = this.bones.get(short);
    if (!b || b.length === 0) throw new Error(`TackleRagdoll: missing bone ${short}`);
    return b;
  }

  private bone(short: string): THREE.Bone {
    return this.boneList(short)[0];
  }

  /**
   * Spawn the ragdoll at the skeleton's current world pose and knock it down. `carryVel` is
   * the player's running momentum (carried into the fall by every segment). The hit is a
   * `hitDir` (unit) at `hitSpeed` (m/s) applied to one tier of the body while the rest lags,
   * so the body topples around the hit:
   *  - high hit (default): upper body takes it -> knocked backward/down off the legs;
   *  - low hit (`hitLow`): the legs take it -> they're cut out and the torso flips forward.
   */
  spawn(carryVel: THREE.Vector3, hitDir: THREE.Vector3, hitSpeed: number, hitLow = false, collisionBit = 0x0002): void {
    if (this.active) this.dispose();
    // Membership = this ragdoll's bit; it collides with the ground (0x0001) and its OWN bit
    // (self-collision stops limbs melting through the torso) but NOT other ragdolls' bits, so
    // two bodies in a tackle pile each stay stable instead of exploding into each other.
    this.groups = ((collisionBit & 0xffff) << 16) | (0x0001 | (collisionBit & 0xffff));
    const world = this.physics.world;
    const R = this.physics.rapier;
    const byName = new Map<string, Seg>();
    this.age = 0;
    // Joints solve far more stably with more substeps — the key fix for "goes crazy".
    this.prevSubsteps = this.physics.substeps;
    this.physics.substeps = 8;
    const hitVel = _upVel.copy(hitDir).multiplyScalar(hitSpeed).add(carryVel); // tier that's hit
    const midVel = _midVel.copy(hitDir).multiplyScalar(hitSpeed * 0.45).add(carryVel); // pelvis

    for (const def of SEGS) {
      const top = this.bone(def.top);
      const bot = this.bone(def.bot);
      top.getWorldPosition(_a);
      bot.getWorldPosition(_b);
      _c.addVectors(_a, _b).multiplyScalar(0.5); // segment center
      _dir.subVectors(_b, _a);
      const len = Math.max(0.04, _dir.length());
      _dir.divideScalar(len);
      _q.setFromUnitVectors(_UP, _dir); // capsule local +Y -> bone direction

      // Velocity tiers: the hit tier gets the full hit, pelvis half, the other tier just the
      // carry. A high hit drives the upper body; a low hit drives the legs (cuts them out).
      const isLeg = LOWER.has(def.name);
      const isPelvis = def.name === "pelvis";
      const v = isPelvis ? midVel : (isLeg === hitLow ? hitVel : carryVel);
      const bodyDesc = R.RigidBodyDesc.dynamic()
        .setTranslation(_c.x, _c.y, _c.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinvel(v.x, v.y, v.z)
        .setAngularDamping(6.0)
        .setLinearDamping(0.4)
        .setCanSleep(true);
      const body = world.createRigidBody(bodyDesc);
      const half = Math.max(0.02, len / 2 - def.r);
      const col = R.ColliderDesc.capsule(half, def.r)
        .setDensity(0)
        .setMass(def.m)
        .setFriction(0.8)
        .setRestitution(0.0)
        .setCollisionGroups(this.groups);
      world.createCollider(col, body);

      const driveBone = this.bone(def.drives);
      // qOffset so that boneWorldQ = bodyWorldQ * qOffset (captured now).
      driveBone.getWorldQuaternion(_q2); // bone world Q
      const qOffset = _pq.copy(_q).invert().multiply(_q2).clone();
      // root position offset (bone world pos relative to body, in body frame)
      driveBone.getWorldPosition(_wp);
      const posOffset = _b.copy(_wp).sub(_c).applyQuaternion(_q.clone().invert()).clone();

      const seg: Seg = {
        ...def, body, center: _c.clone(), qOffset, posOffset,
        driveBone, driveBones: this.boneList(def.drives),
        parentSeg: null, qRelRest: new THREE.Quaternion(),
      };
      this.segs.push(seg);
      byName.set(def.name, seg);
    }

    // Link each segment to its parent with a spherical joint; the joint's range of motion is
    // enforced softly per-substep (see applyLimits) rather than by the joint itself, which
    // gives stable cone+twist limits without fragile per-joint hinge axes.
    for (const seg of this.segs) {
      if (!seg.parent) continue;
      const parent = byName.get(seg.parent)!;
      seg.parentSeg = parent;
      // Neutral relative orientation at spawn (the pose the soft limits measure deviation from).
      seg.qRelRest.copy(quatOf(parent.body)).invert().multiply(quatOf(seg.body));
      this.bone(seg.top).getWorldPosition(_a); // joint world pos
      // _q becomes childBodyQ^-1, _q2 becomes parentBodyQ^-1 (reused as the fixed-joint frames).
      const aChild = _b.copy(_a).sub(seg.center).applyQuaternion(_q.copy(quatOf(seg.body)).invert());
      const aParent = _c.copy(_a).sub(parent.center).applyQuaternion(_q2.copy(quatOf(parent.body)).invert());
      // Wrists/ankles are welded rigid (fixed joint) so they can't twist and pinch the mesh;
      // everything else is a ball joint with soft cone+twist limits. Frames = the bodies'
      // inverse rotations, so the weld preserves the spawn relative pose.
      const data = seg.fixed
        ? R.JointData.fixed(
            { x: aParent.x, y: aParent.y, z: aParent.z }, { x: _q2.x, y: _q2.y, z: _q2.z, w: _q2.w },
            { x: aChild.x, y: aChild.y, z: aChild.z }, { x: _q.x, y: _q.y, z: _q.z, w: _q.w },
          )
        : R.JointData.spherical(
            { x: aParent.x, y: aParent.y, z: aParent.z },
            { x: aChild.x, y: aChild.y, z: aChild.z },
          );
      const joint = world.createImpulseJoint(data, parent.body, seg.body, true);
      // Adjacent segments share a joint and overlap there — don't let them collide.
      (joint as unknown as { setContactsEnabled?: (b: boolean) => void }).setContactsEnabled?.(false);
    }

    this.active = true;
  }

  /**
   * Soft cone+twist joint limits, applied once per physics substep (pass as the step's
   * preSubstep hook). Within each joint's range the ragdoll is free/limp; beyond it, a spring
   * pushes back. The TWIST limit is what stops the skin candy-wrappering (the stretched
   * forearm / "detached" foot); the SWING (cone) limit stops the body folding in half. Torque
   * impulses are dt-scaled so the result is substep-invariant.
   */
  applyLimits(dt: number): void {
    if (!this.active) return;
    // Safety floor: never let a body sink under the turf (catches rare tunneling / solver blowups
    // from a hard hit). Keep each capsule's center at/above its radius and kill downward velocity.
    for (const seg of this.segs) {
      const t = seg.body.translation();
      const minY = seg.r * 0.85;
      if (t.y < minY) {
        seg.body.setTranslation({ x: t.x, y: minY, z: t.z }, true);
        const v = seg.body.linvel();
        if (v.y < 0) seg.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
      }
    }
    // The limits matter only DURING the fall (to stop the mesh candy-wrappering while the
    // body whips around fast). Once it's down, a limb resting on the ground at a beyond-limit
    // angle would fight the ground forever and buzz — so we fade the limits out over the first
    // ~1.5s and then leave the body fully limp to settle.
    this.age += dt;
    const fade = this.age < 1.0 ? 1 : this.age < 1.6 ? (1.6 - this.age) / 0.6 : 0;
    if (fade <= 0) return;
    // Soft + overdamped: a gentle spring past the limit + strong relative-velocity damping.
    const kSwing = 7 * fade, kTwist = 7 * fade, kDamp = 4.5, dead = 0.06, maxT = 12;
    for (const seg of this.segs) {
      const parent = seg.parentSeg;
      if (!parent || seg.sw === undefined) continue;
      const wc = seg.body.angvel(), wp = parent.body.angvel();
      const relx = wc.x - wp.x, rely = wc.y - wp.y, relz = wc.z - wp.z;
      const calm = relx * relx + rely * rely + relz * relz < 0.04; // ~0.2 rad/s

      const pr = parent.body.rotation(); _lpQ.set(pr.x, pr.y, pr.z, pr.w);
      const cr = seg.body.rotation(); _lcQ.set(cr.x, cr.y, cr.z, cr.w);
      // qRel = parentQ^-1 * childQ ; qDev = qRelRest^-1 * qRel  (deviation, in rest-child frame)
      _ltmp.copy(_lpQ).invert();
      _lrel.copy(_ltmp).multiply(_lcQ);
      _ldev.copy(seg.qRelRest).invert().multiply(_lrel);
      if (_ldev.w < 0) { _ldev.x = -_ldev.x; _ldev.y = -_ldev.y; _ldev.z = -_ldev.z; _ldev.w = -_ldev.w; }
      // swing/twist decomposition about the bone axis (+Y in the segment frame)
      const twistAngle = 2 * Math.atan2(_ldev.y, _ldev.w);
      const s = Math.sin(twistAngle / 2), cw = Math.cos(twistAngle / 2);
      _ltwistInv.set(0, -s, 0, cw); // inverse of the twist quaternion
      _lswing.copy(_ldev).multiply(_ltwistInv);
      if (_lswing.w < 0) { _lswing.x = -_lswing.x; _lswing.y = -_lswing.y; _lswing.z = -_lswing.z; _lswing.w = -_lswing.w; }
      const swingAngle = 2 * Math.acos(Math.min(1, _lswing.w));

      const overSwing = swingAngle > seg.sw + dead;
      const tl = seg.tw ?? 0.4;
      const overTwist = twistAngle > tl + dead || twistAngle < -tl - dead;
      // Calm AND inside the limits -> leave it alone so it can settle and sleep.
      if (calm && !overSwing && !overTwist) continue;

      _ltorque.set(0, 0, 0);
      if (overSwing) {
        const len = Math.hypot(_lswing.x, _lswing.y, _lswing.z) || 1;
        const k = (-kSwing * (swingAngle - seg.sw)) / len;
        _ltorque.set(_lswing.x * k, _lswing.y * k, _lswing.z * k); // push swing back toward the limit
      }
      if (twistAngle > tl) _ltorque.y += -kTwist * (twistAngle - tl);
      else if (twistAngle < -tl) _ltorque.y += -kTwist * (twistAngle + tl);
      // rotate the (rest-child-frame) spring correction into world
      _lrest.copy(_lpQ).multiply(seg.qRelRest);
      _ltorque.applyQuaternion(_lrest);
      // strong damping on the relative angular velocity (clamped) — kills the ringing
      const rlen = Math.hypot(relx, rely, relz);
      const rs = rlen > 8 ? 8 / rlen : 1; // cap the velocity we damp against
      _ltorque.x -= kDamp * relx * rs;
      _ltorque.y -= kDamp * rely * rs;
      _ltorque.z -= kDamp * relz * rs;
      // Clamp the TOTAL torque and bail on anything non-finite (no Rapier NaN panics). Applied
      // only to the child — torquing shared parents too made them accumulate and blow up.
      const tlen = _ltorque.length();
      if (!Number.isFinite(tlen)) continue;
      if (tlen > maxT) _ltorque.multiplyScalar(maxT / tlen);
      seg.body.applyTorqueImpulse({ x: _ltorque.x * dt, y: _ltorque.y * dt, z: _ltorque.z * dt }, true);
    }
  }

  /** Each frame after stepping physics: clamp spin, then drive the skinned mesh bones. */
  drive(): void {
    if (!this.active) return;
    for (const seg of this.segs) {
      // Clamp angular velocity so no body can spin up into a contorted blur.
      const w = seg.body.angvel();
      const m2 = w.x * w.x + w.y * w.y + w.z * w.z;
      if (m2 > MAX_SPIN * MAX_SPIN) {
        const s = MAX_SPIN / Math.sqrt(m2);
        seg.body.setAngvel({ x: w.x * s, y: w.y * s, z: w.z * s }, true);
      }
      const t = seg.body.translation();
      const r = seg.body.rotation();
      _q.set(r.x, r.y, r.z, r.w); // body world Q
      _q2.copy(_q).multiply(seg.qOffset); // target bone world Q (same for every instance)
      // Target bone world POSITION from the body. Driving position (not just rotation) makes
      // the mesh follow the physics exactly instead of drifting via rigid forward-kinematics.
      _wp.set(t.x, t.y, t.z).add(_dir.copy(seg.posOffset).applyQuaternion(_q));
      // Apply to EVERY instance of this bone (one per skeleton), each via its own parent.
      for (const bone of seg.driveBones) {
        const parent = bone.parent!;
        parent.getWorldQuaternion(_pq); // parent world Q (updates ancestors)
        bone.quaternion.copy(_pq.invert().multiply(_q2)); // local = parentWorld^-1 * targetWorld
        _wp2.copy(_wp);
        parent.worldToLocal(_wp2);
        bone.position.copy(_wp2);
        bone.updateWorldMatrix(false, false); // refresh for children read below
      }
    }
  }

  /** Lowest body point (to know when the fall has settled). */
  lowestY(): number {
    let y = Infinity;
    for (const seg of this.segs) y = Math.min(y, seg.body.translation().y);
    return y;
  }

  /** Debug: body vs driven-bone world Y per segment (to spot drive/position drift). */
  debug(): { name: string; bodyY: number; boneY: number }[] {
    const v = new THREE.Vector3();
    return this.segs.map((s) => {
      s.driveBone.getWorldPosition(v);
      return { name: s.name, bodyY: +s.body.translation().y.toFixed(3), boneY: +v.y.toFixed(3) };
    });
  }

  /** Sum of linear+angular speed across all bodies — ~0 when settled, high if it's buzzing. */
  residualMotion(): number {
    let m = 0;
    for (const seg of this.segs) {
      const v = seg.body.linvel(), w = seg.body.angvel();
      m += Math.hypot(v.x, v.y, v.z) + Math.hypot(w.x, w.y, w.z);
    }
    return m;
  }

  /** Roughly at rest? (all bodies nearly stopped) */
  settled(): boolean {
    if (!this.active) return false;
    for (const seg of this.segs) {
      const v = seg.body.linvel();
      if (v.x * v.x + v.y * v.y + v.z * v.z > 0.02) return false;
    }
    return true;
  }

  dispose(): void {
    for (const seg of this.segs) this.physics.world.removeRigidBody(seg.body);
    this.segs = [];
    this.active = false;
    this.physics.substeps = this.prevSubsteps;
  }
}

function quatOf(b: RAPIER.RigidBody): THREE.Quaternion {
  const r = b.rotation();
  return new THREE.Quaternion(r.x, r.y, r.z, r.w);
}
