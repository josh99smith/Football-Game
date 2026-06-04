import RAPIER from "@dimforge/rapier3d-compat";

/**
 * Thin wrapper over a Rapier3D physics world (metric units: metres, kg, seconds).
 *
 * Owns world creation (Rapier loads via async WASM, so use `PhysicsWorld.create()`),
 * a fixed 60 Hz step with optional substepping for joint stability, a flat ground, and
 * a downward ground raycast (for foot placement in later slices). Everything physical —
 * mass, momentum, collisions — lives here; higher layers only read/drive bodies.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly rapier = RAPIER;
  /** Internal substeps per 1/60 frame — more = more stable joints, more cost. */
  substeps = 2;

  private constructor(world: RAPIER.World) {
    this.world = world;
    world.timestep = 1 / 60;
  }

  static async create(gravityY = -9.81): Promise<PhysicsWorld> {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    const pw = new PhysicsWorld(world);
    pw.addGround();
    return pw;
  }

  private addGround(): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0).setFriction(1.4),
      body,
    );
  }

  /**
   * Advance one 1/60 frame. `preSubstep(dt)` runs before every internal substep so
   * joint "muscles" (PD torques) are re-applied each substep — torque impulses must be
   * dt-scaled by the caller so the result is substep-invariant.
   */
  step(preSubstep?: (dt: number) => void): void {
    const sub = Math.max(1, this.substeps | 0);
    const dt = 1 / 60 / sub;
    this.world.timestep = dt;
    for (let i = 0; i < sub; i++) {
      preSubstep?.(dt);
      this.world.step();
    }
    this.world.timestep = 1 / 60;
  }

  /** Ground height under (x, z), or null if nothing below. Used for foot IK later. */
  groundY(x: number, z: number, fromY = 4): number | null {
    const ray = new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, fromY + 2, true);
    return hit ? fromY - hit.timeOfImpact : null;
  }
}
