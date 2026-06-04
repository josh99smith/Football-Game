/**
 * Data-only humanoid ragdoll spec (metric). Tunable without code changes — masses are
 * roughly anthropometric and sum to ~103 kg (~228 lb). Bodies are authored at their
 * rest (standing, arms-down) positions with IDENTITY rotation, so the rest relative
 * orientation of every joint is identity and a target of identity holds the stand pose.
 *
 * Y up, Z forward, X right. Capsules are Y-aligned (matches vertical limbs).
 */

export type Vec3 = { x: number; y: number; z: number };

export type BoneShape =
  | { kind: "capsule"; halfHeight: number; radius: number }
  | { kind: "box"; hx: number; hy: number; hz: number }
  | { kind: "ball"; radius: number };

export interface BoneDef {
  name: string;
  center: Vec3; // rest world position of the body centre
  mass: number; // kg
  shape: BoneShape;
}

export interface JointDef {
  name: string;
  parent: string;
  child: string;
  pivot: Vec3; // rest world position of the joint pivot
  type: "spherical" | "revolute";
  axis?: Vec3; // revolute hinge axis (local == world at rest)
  limits?: [number, number]; // revolute ROM (radians)
  stiffness: number; // 0..1 default muscle stiffness
  damping: number; // muscle damping multiplier
}

export interface RagdollSpec {
  bones: BoneDef[];
  joints: JointDef[];
}

const mirror = (b: BoneDef, sx: number): BoneDef => ({
  ...b,
  name: b.name.replace("L", "R"),
  center: { ...b.center, x: b.center.x * sx },
});

const baseBones: BoneDef[] = [
  { name: "pelvis", center: { x: 0, y: 0.95, z: 0 }, mass: 20, shape: { kind: "box", hx: 0.16, hy: 0.12, hz: 0.11 } },
  { name: "chest", center: { x: 0, y: 1.32, z: 0 }, mass: 28, shape: { kind: "box", hx: 0.18, hy: 0.18, hz: 0.12 } },
  { name: "head", center: { x: 0, y: 1.66, z: 0 }, mass: 9, shape: { kind: "ball", radius: 0.12 } },
  { name: "upperArmL", center: { x: -0.22, y: 1.28, z: 0 }, mass: 3.2, shape: { kind: "capsule", halfHeight: 0.12, radius: 0.05 } },
  { name: "forearmL", center: { x: -0.24, y: 1.0, z: 0 }, mass: 2.4, shape: { kind: "capsule", halfHeight: 0.13, radius: 0.045 } },
  { name: "thighL", center: { x: -0.1, y: 0.62, z: 0 }, mass: 11, shape: { kind: "capsule", halfHeight: 0.18, radius: 0.07 } },
  { name: "shinL", center: { x: -0.1, y: 0.24, z: 0 }, mass: 5, shape: { kind: "capsule", halfHeight: 0.18, radius: 0.06 } },
  { name: "footL", center: { x: -0.1, y: 0.05, z: 0.06 }, mass: 1.6, shape: { kind: "box", hx: 0.05, hy: 0.04, hz: 0.12 } },
];

const baseJoints: JointDef[] = [
  { name: "spine", parent: "pelvis", child: "chest", pivot: { x: 0, y: 1.13, z: 0 }, type: "spherical", stiffness: 0.85, damping: 1.0 },
  { name: "neck", parent: "chest", child: "head", pivot: { x: 0, y: 1.5, z: 0 }, type: "spherical", stiffness: 0.7, damping: 1.0 },
  { name: "shoulderL", parent: "chest", child: "upperArmL", pivot: { x: -0.2, y: 1.42, z: 0 }, type: "spherical", stiffness: 0.6, damping: 0.9 },
  { name: "elbowL", parent: "upperArmL", child: "forearmL", pivot: { x: -0.23, y: 1.14, z: 0 }, type: "revolute", axis: { x: 1, y: 0, z: 0 }, limits: [-2.6, 0.1], stiffness: 0.6, damping: 0.9 },
  { name: "hipL", parent: "pelvis", child: "thighL", pivot: { x: -0.1, y: 0.85, z: 0 }, type: "spherical", stiffness: 0.8, damping: 1.0 },
  { name: "kneeL", parent: "thighL", child: "shinL", pivot: { x: -0.1, y: 0.43, z: 0 }, type: "revolute", axis: { x: 1, y: 0, z: 0 }, limits: [-0.1, 2.6], stiffness: 0.8, damping: 1.0 },
  { name: "ankleL", parent: "shinL", child: "footL", pivot: { x: -0.1, y: 0.06, z: 0 }, type: "revolute", axis: { x: 1, y: 0, z: 0 }, limits: [-0.6, 0.6], stiffness: 0.7, damping: 1.0 },
];

/** Build the symmetric humanoid spec (mirrors the left side to the right). */
export function humanoidSpec(): RagdollSpec {
  const bones = [...baseBones];
  for (const b of baseBones) if (b.name.endsWith("L")) bones.push(mirror(b, -1));

  const joints = [...baseJoints];
  for (const j of baseJoints) {
    if (!j.name.endsWith("L")) continue;
    joints.push({
      ...j,
      name: j.name.replace("L", "R"),
      parent: j.parent.endsWith("L") ? j.parent.replace("L", "R") : j.parent,
      child: j.child.replace("L", "R"),
      pivot: { ...j.pivot, x: -j.pivot.x },
    });
  }
  return { bones, joints };
}

/** Total authored mass (kg) — handy for the debug panel. */
export function specMass(spec: RagdollSpec): number {
  return spec.bones.reduce((s, b) => s + b.mass, 0);
}
