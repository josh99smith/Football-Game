import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import type { PhysicsWorld } from "./PhysicsWorld";
import { type RagdollSpec, type BoneDef, type JointDef, humanoidSpec } from "./RagdollConfig";

/** A driven joint: the Rapier constraint plus the PD-"muscle" state. */
interface Muscle {
  def: JointDef;
  parent: RAPIER.RigidBody;
  child: RAPIER.RigidBody;
  /** Target orientation of the child RELATIVE to the parent (identity == rest pose). */
  target: THREE.Quaternion;
  stiffness: number; // 0..1
  damping: number; // multiplier
  /** Pivot in the parent's local frame (to find the world pivot each step). */
  anchorParent: { x: number; y: number; z: number };
  /** Bodies + masses supported by this joint (the child's whole sub-tree) — for the
   * gravity-compensation feed-forward that lets the muscle hold weight. */
  subtree: { body: RAPIER.RigidBody; mass: number }[];
  /** Child's scalar angular inertia (mean principal) — scales the PD into torque so one
   * gain works for both a 3 kg forearm and a 28 kg chest. */
  childInertia: number;
}

export interface BoneTransform {
  name: string;
  def: BoneDef;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

const _qp = new THREE.Quaternion();
const _qc = new THREE.Quaternion();
const _qDes = new THREE.Quaternion();
const _qErr = new THREE.Quaternion();
const _tmp = new THREE.Quaternion();
const _err = new THREE.Vector3();

/** Axis*angle (rotation vector) of a quaternion, taking the shortest path. */
function rotationVector(q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; } // shortest arc
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-5) return out.set(0, 0, 0);
  const angle = 2 * Math.acos(Math.min(1, w));
  const k = angle / s;
  return out.set(x * k, y * k, z * k);
}

/**
 * An active ragdoll: every limb is a rigid body, every joint a constraint driven toward
 * a target pose by a code-side PD controller (Rapier's JS bindings expose motors only on
 * 1-DOF joints, so we drive all joints uniformly with applyTorqueImpulse instead). The
 * per-joint `stiffness` (0..1) is the central knob: high tracks the target pose tightly,
 * 0 goes slack and gravity/collisions take over.
 */
export class Ragdoll {
  readonly spec: RagdollSpec;
  private readonly physics: PhysicsWorld;
  private readonly bodies = new Map<string, RAPIER.RigidBody>();
  private readonly muscles: Muscle[] = [];
  /** Body suspended (kinematic) for the Slice-1 demo, so limbs hang as stable pendulums
   * and the stiffness knob is shown by holding a posed limb out vs. letting it drop. */
  private readonly anchorBone = "chest";
  private anchored = true;
  /** Interaction groups: member of bit 1, collides with everything EXCEPT bit 1 — so a
   * ragdoll's limbs don't self-collide but still hit the ground/world. (Per-ragdoll bits
   * for ragdoll-vs-ragdoll contact come in the contact slice.) */
  private readonly selfGroups = ((0x0002 << 16) | 0xfffd) >>> 0;

  // Live-tunable muscle gains (acceleration-based: rad/s² per rad of error, scaled by
  // each body's real inertia). Sane starting points; tuning to "athletic" is the work.
  Kp = 260; // proportional gain (~ω²; firmness)
  Kd = 32; // derivative gain (~2ω; damping)
  maxImpulse = 60; // per-axis impulse clamp (N·m·s) so a bad gain can't explode the sim

  constructor(physics: PhysicsWorld, spec: RagdollSpec = humanoidSpec()) {
    this.physics = physics;
    this.spec = spec;
    this.build();
  }

  private build(): void {
    const R = this.physics.rapier;
    const world = this.physics.world;

    for (const b of this.spec.bones) {
      const desc = R.RigidBodyDesc.dynamic()
        .setTranslation(b.center.x, b.center.y, b.center.z)
        .setLinearDamping(0.05)
        .setAngularDamping(0.4)
        .setCanSleep(false);
      const body = world.createRigidBody(desc);

      let cd: RAPIER.ColliderDesc;
      if (b.shape.kind === "capsule") cd = R.ColliderDesc.capsule(b.shape.halfHeight, b.shape.radius);
      else if (b.shape.kind === "ball") cd = R.ColliderDesc.ball(b.shape.radius);
      else cd = R.ColliderDesc.cuboid(b.shape.hx, b.shape.hy, b.shape.hz);
      cd.setMass(b.mass).setFriction(0.9).setRestitution(0);
      // A ragdoll's own limbs must NOT collide with each other (overlapping jointed
      // capsules would explode apart) — but they DO collide with the ground/world.
      cd.setCollisionGroups(this.selfGroups);
      world.createCollider(cd, body);
      this.bodies.set(b.name, body);
    }

    for (const j of this.spec.joints) {
      const parent = this.bodies.get(j.parent)!;
      const child = this.bodies.get(j.child)!;
      const pc = this.spec.bones.find((b) => b.name === j.parent)!.center;
      const cc = this.spec.bones.find((b) => b.name === j.child)!.center;
      const a1 = { x: j.pivot.x - pc.x, y: j.pivot.y - pc.y, z: j.pivot.z - pc.z };
      const a2 = { x: j.pivot.x - cc.x, y: j.pivot.y - cc.y, z: j.pivot.z - cc.z };

      let data: RAPIER.JointData;
      if (j.type === "revolute") data = R.JointData.revolute(a1, a2, j.axis!);
      else data = R.JointData.spherical(a1, a2);

      const joint = world.createImpulseJoint(data, parent, child, true);
      if (j.type === "revolute" && j.limits) {
        (joint as RAPIER.RevoluteImpulseJoint).setLimits(j.limits[0], j.limits[1]);
      }
      const subtree = this.subtreeBodies(j.child).map((name) => ({
        body: this.bodies.get(name)!,
        mass: this.spec.bones.find((b) => b.name === name)!.mass,
      }));
      const pi = child.principalInertia();
      const childInertia = Math.max(1e-3, (pi.x + pi.y + pi.z) / 3);
      this.muscles.push({ def: j, parent, child, target: new THREE.Quaternion(), stiffness: j.stiffness, damping: j.damping, anchorParent: a1, subtree, childInertia });
    }

    this.setAnchorPinned(true);
  }

  /** Names of every body in the sub-tree rooted at `name` (inclusive), via the joint tree. */
  private subtreeBodies(name: string): string[] {
    const out = [name];
    for (const j of this.spec.joints) if (j.parent === name) out.push(...this.subtreeBodies(j.child));
    return out;
  }

  /** Re-apply every joint's PD muscle. Call once per physics substep; `dt` is the
   * substep length so the torque impulses are substep-invariant. */
  update(dt: number): void {
    const G = 9.81;
    for (const m of this.muscles) {
      if (m.stiffness <= 0) continue;

      // --- Gravity compensation: hold the supported sub-tree's weight ---
      // World pivot = parent position + parent rotation * (pivot in parent local).
      const rp0 = m.parent.rotation();
      _qp.set(rp0.x, rp0.y, rp0.z, rp0.w);
      _err.set(m.anchorParent.x, m.anchorParent.y, m.anchorParent.z).applyQuaternion(_qp);
      const pt = m.parent.translation();
      const px = pt.x + _err.x, pz = pt.z + _err.z; // pivot world XZ (gravity torque is horizontal)
      // Gravity about a vertical pivot has only horizontal components: τ = Σ r × (0,-mg,0).
      let gx = 0, gz = 0;
      for (const s of m.subtree) {
        const bt = s.body.translation();
        const mg = s.mass * G;
        gx += (bt.z - pz) * mg; // r × f, x component
        gz += -(bt.x - px) * mg; // z component
      }
      const ff = m.stiffness * dt;
      const fx = -gx * ff, fz = -gz * ff; // feed-forward holds the weight up
      m.child.applyTorqueImpulse({ x: fx, y: 0, z: fz }, true);
      m.parent.applyTorqueImpulse({ x: -fx, y: 0, z: -fz }, true);

      // --- PD muscle: track the target relative orientation ---
      const rp = m.parent.rotation();
      const rc = m.child.rotation();
      _qp.set(rp.x, rp.y, rp.z, rp.w);
      _qc.set(rc.x, rc.y, rc.z, rc.w);
      // Desired child world orientation = parent * targetRelative.
      _qDes.copy(_qp).multiply(m.target);
      // Error rotation (world): from current child to desired.
      _qErr.copy(_qDes).multiply(_tmp.copy(_qc).invert());
      rotationVector(_qErr, _err);

      const wp = m.parent.angvel();
      const wc = m.child.angvel();
      const inertia = m.childInertia; // real angular inertia -> acceleration-based PD
      const kp = this.Kp * m.stiffness;
      const kd = this.Kd * m.damping;
      const clamp = this.maxImpulse;
      const ix = clampAbs((_err.x * kp - (wc.x - wp.x) * kd) * inertia * dt, clamp);
      const iy = clampAbs((_err.y * kp - (wc.y - wp.y) * kd) * inertia * dt, clamp);
      const iz = clampAbs((_err.z * kp - (wc.z - wp.z) * kd) * inertia * dt, clamp);
      m.child.applyTorqueImpulse({ x: ix, y: iy, z: iz }, true);
      m.parent.applyTorqueImpulse({ x: -ix, y: -iy, z: -iz }, true); // Newton's third law
    }
  }

  // --- control --------------------------------------------------------------

  setStiffness(v: number): void {
    for (const m of this.muscles) m.stiffness = v;
  }

  setJointStiffness(name: string, v: number): void {
    const m = this.muscles.find((x) => x.def.name === name);
    if (m) m.stiffness = v;
  }

  /** Set per-joint target orientations (child relative to parent). Missing joints hold. */
  setTargetPose(pose: Record<string, THREE.Quaternion>): void {
    for (const m of this.muscles) {
      const t = pose[m.def.name];
      if (t) m.target.copy(t);
    }
  }

  /** Restore the rest (standing) target on every joint. */
  resetTargets(): void {
    for (const m of this.muscles) m.target.identity();
  }

  setLimp(): void {
    this.setStiffness(0);
  }

  setAnchorPinned(pinned: boolean): void {
    this.anchored = pinned;
    const body = this.bodies.get(this.anchorBone)!;
    body.setBodyType(
      pinned ? this.physics.rapier.RigidBodyType.KinematicPositionBased : this.physics.rapier.RigidBodyType.Dynamic,
      true,
    );
  }

  get isPinned(): boolean {
    return this.anchored;
  }

  /** Teleport every body back to its rest pose and stop it dead. */
  reset(): void {
    for (const b of this.spec.bones) {
      const body = this.bodies.get(b.name)!;
      body.setTranslation({ x: b.center.x, y: b.center.y, z: b.center.z }, true);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.resetTargets();
  }

  /** Apply a one-off impulse to the chest (the debug "Nudge" button). */
  nudge(strength = 6): void {
    const chest = this.bodies.get("chest")!;
    chest.applyImpulse({ x: (Math.random() - 0.5) * strength, y: 0, z: strength }, true);
  }

  // --- read-out -------------------------------------------------------------

  /** Raw rigid body for a bone (used by the locomotion controller to read positions
   * and apply balance/foot-lock forces). */
  body(name: string): RAPIER.RigidBody {
    return this.bodies.get(name)!;
  }

  /** Mean principal angular inertia of a bone (for acceleration-based assist torques). */
  inertiaMean(name: string): number {
    const pi = this.bodies.get(name)!.principalInertia();
    return Math.max(1e-3, (pi.x + pi.y + pi.z) / 3);
  }

  getBoneTransforms(out: BoneTransform[]): BoneTransform[] {
    for (let i = 0; i < this.spec.bones.length; i++) {
      const b = this.spec.bones[i];
      const body = this.bodies.get(b.name)!;
      const t = body.translation();
      const r = body.rotation();
      const slot = (out[i] ??= { name: b.name, def: b, position: new THREE.Vector3(), quaternion: new THREE.Quaternion() });
      slot.name = b.name;
      slot.def = b;
      slot.position.set(t.x, t.y, t.z);
      slot.quaternion.set(r.x, r.y, r.z, r.w);
    }
    return out;
  }

  /** Mass-weighted centre of mass (for balance/debug in later slices). */
  getCOM(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    let total = 0;
    for (const b of this.spec.bones) {
      const body = this.bodies.get(b.name)!;
      const t = body.translation();
      out.x += t.x * b.mass;
      out.y += t.y * b.mass;
      out.z += t.z * b.mass;
      total += b.mass;
    }
    return out.multiplyScalar(1 / total);
  }
}

function clampAbs(v: number, max: number): number {
  return v > max ? max : v < -max ? -max : v;
}
