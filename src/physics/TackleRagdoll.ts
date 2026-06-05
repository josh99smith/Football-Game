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
const GROUPS = 0x00020001; // membership 0x0002, filter 0x0001 -> hits ground, not itself

interface SegDef {
  name: string;
  top: string; // bone at the segment's parent-end (the joint to the parent)
  bot: string; // bone at the far end (defines length + direction)
  drives: string; // which bone this body's orientation drives
  parent: string | null;
  r: number; // capsule radius (m)
  m: number; // mass (kg)
}

// Major segments of the body, parents before children (drive order depends on it).
const SEGS: SegDef[] = [
  { name: "pelvis", top: "Hips", bot: "Spine1", drives: "Hips", parent: null, r: 0.12, m: 12 },
  { name: "torso", top: "Spine1", bot: "Neck", drives: "Spine1", parent: "pelvis", r: 0.13, m: 16 },
  { name: "head", top: "Neck", bot: "HeadTop_End", drives: "Neck", parent: "torso", r: 0.09, m: 4.5 },
  { name: "thighL", top: "LeftUpLeg", bot: "LeftLeg", drives: "LeftUpLeg", parent: "pelvis", r: 0.085, m: 7 },
  { name: "shinL", top: "LeftLeg", bot: "LeftFoot", drives: "LeftLeg", parent: "thighL", r: 0.06, m: 4 },
  { name: "footL", top: "LeftFoot", bot: "LeftToeBase", drives: "LeftFoot", parent: "shinL", r: 0.05, m: 1 },
  { name: "thighR", top: "RightUpLeg", bot: "RightLeg", drives: "RightUpLeg", parent: "pelvis", r: 0.085, m: 7 },
  { name: "shinR", top: "RightLeg", bot: "RightFoot", drives: "RightLeg", parent: "thighR", r: 0.06, m: 4 },
  { name: "footR", top: "RightFoot", bot: "RightToeBase", drives: "RightFoot", parent: "shinR", r: 0.05, m: 1 },
  { name: "uarmL", top: "LeftArm", bot: "LeftForeArm", drives: "LeftArm", parent: "torso", r: 0.05, m: 2.5 },
  { name: "farmL", top: "LeftForeArm", bot: "LeftHand", drives: "LeftForeArm", parent: "uarmL", r: 0.045, m: 1.5 },
  { name: "uarmR", top: "RightArm", bot: "RightForeArm", drives: "RightArm", parent: "torso", r: 0.05, m: 2.5 },
  { name: "farmR", top: "RightForeArm", bot: "RightHand", drives: "RightForeArm", parent: "uarmR", r: 0.045, m: 1.5 },
];

interface Seg extends SegDef {
  body: RAPIER.RigidBody;
  center: THREE.Vector3; // world center at spawn
  qOffset: THREE.Quaternion; // bodyWorldQ^-1 * boneWorldQ at spawn (drive: boneWorldQ = bodyQ * qOffset)
  posOffset: THREE.Vector3; // root only: bodyQ^-1 * (boneWorldPos - bodyWorldPos)
  driveBone: THREE.Bone;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _wp = new THREE.Vector3();
const _upVel = new THREE.Vector3();
const _midVel = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

const LOWER = new Set(["thighL", "shinL", "footL", "thighR", "shinR", "footR"]);
const MAX_SPIN = 16; // rad/s — clamp so a body can never spin up into a contorted blur

export class TackleRagdoll {
  active = false;
  private readonly physics: PhysicsWorld;
  private segs: Seg[] = [];
  private bones = new Map<string, THREE.Bone>();
  private prevSubsteps = 2;

  constructor(physics: PhysicsWorld) {
    this.physics = physics;
  }

  /** Collect the rig's bones by short name (mixamorig prefix stripped). */
  bind(root: THREE.Object3D): void {
    root.traverse((o) => {
      if ((o as THREE.Bone).isBone && o.name.startsWith(MIX)) {
        this.bones.set(o.name.slice(MIX.length), o as THREE.Bone);
      }
    });
  }

  /** Public lookup of a bound bone by short (prefix-stripped) name. */
  getBone(short: string): THREE.Bone | undefined {
    return this.bones.get(short);
  }

  private bone(short: string): THREE.Bone {
    const b = this.bones.get(short);
    if (!b) throw new Error(`TackleRagdoll: missing bone ${short}`);
    return b;
  }

  /**
   * Spawn the ragdoll at the skeleton's current world pose and knock it down. `carryVel` is
   * the player's running velocity; the hit is a `hitDir` (unit) at `hitSpeed` (m/s) applied
   * to the UPPER body while the legs lag — so the body topples over its feet and falls,
   * instead of one segment being yanked by a giant impulse (which spun/contorted it).
   */
  spawn(carryVel: THREE.Vector3, hitDir: THREE.Vector3, hitSpeed: number): void {
    if (this.active) this.dispose();
    const world = this.physics.world;
    const R = this.physics.rapier;
    const byName = new Map<string, Seg>();
    // Joints solve far more stably with more substeps — the key fix for "goes crazy".
    this.prevSubsteps = this.physics.substeps;
    this.physics.substeps = 8;
    const upVel = _upVel.copy(hitDir).multiplyScalar(hitSpeed).add(carryVel);
    const midVel = _midVel.copy(hitDir).multiplyScalar(hitSpeed * 0.45).add(carryVel);

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

      // Velocity tier: legs lag (carry only), pelvis mid, upper body takes the hit.
      const v = LOWER.has(def.name) ? carryVel : def.name === "pelvis" ? midVel : upVel;
      const bodyDesc = R.RigidBodyDesc.dynamic()
        .setTranslation(_c.x, _c.y, _c.z)
        .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
        .setLinvel(v.x, v.y, v.z)
        .setAngularDamping(4.0)
        .setLinearDamping(0.2)
        .setCanSleep(true);
      const body = world.createRigidBody(bodyDesc);
      const half = Math.max(0.02, len / 2 - def.r);
      const col = R.ColliderDesc.capsule(half, def.r)
        .setDensity(0)
        .setMass(def.m)
        .setFriction(0.8)
        .setRestitution(0.0)
        .setCollisionGroups(GROUPS);
      world.createCollider(col, body);

      const driveBone = this.bone(def.drives);
      // qOffset so that boneWorldQ = bodyWorldQ * qOffset (captured now).
      driveBone.getWorldQuaternion(_q2); // bone world Q
      const qOffset = _pq.copy(_q).invert().multiply(_q2).clone();
      // root position offset (bone world pos relative to body, in body frame)
      driveBone.getWorldPosition(_wp);
      const posOffset = _b.copy(_wp).sub(_c).applyQuaternion(_q.clone().invert()).clone();

      const seg: Seg = { ...def, body, center: _c.clone(), qOffset, posOffset, driveBone };
      this.segs.push(seg);
      byName.set(def.name, seg);
    }

    // Link each segment to its parent with a spherical joint anchored at the shared joint.
    for (const seg of this.segs) {
      if (!seg.parent) continue;
      const parent = byName.get(seg.parent)!;
      this.bone(seg.top).getWorldPosition(_a); // joint world pos
      const aChild = _b.copy(_a).sub(seg.center).applyQuaternion(_q.copy(quatOf(seg.body)).invert());
      const aParent = _c.copy(_a).sub(parent.center).applyQuaternion(_q2.copy(quatOf(parent.body)).invert());
      const data = R.JointData.spherical(
        { x: aParent.x, y: aParent.y, z: aParent.z },
        { x: aChild.x, y: aChild.y, z: aChild.z },
      );
      world.createImpulseJoint(data, parent.body, seg.body, true);
    }

    this.active = true;
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
      _q2.copy(_q).multiply(seg.qOffset); // target bone world Q
      const bone = seg.driveBone;
      const parent = bone.parent!;
      parent.getWorldQuaternion(_pq); // parent world Q (updates ancestors)
      bone.quaternion.copy(_pq.invert().multiply(_q2)); // local = parentWorld^-1 * targetWorld
      if (!seg.parent) {
        // Root: also set Hips world position from the body.
        _wp.set(t.x, t.y, t.z).add(_dir.copy(seg.posOffset).applyQuaternion(_q));
        parent.worldToLocal(_wp);
        bone.position.copy(_wp);
      }
      bone.updateWorldMatrix(false, false); // refresh for children read below
    }
  }

  /** Lowest body point (to know when the fall has settled). */
  lowestY(): number {
    let y = Infinity;
    for (const seg of this.segs) y = Math.min(y, seg.body.translation().y);
    return y;
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
