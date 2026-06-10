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
  /** The fixed ground body (at the world origin; collider offset -0.5). Foot-lock joints
   * pin a planted foot to this so a stance foot cannot slide. */
  groundBody!: RAPIER.RigidBody;
  /** Internal substeps per 1/60 frame — more = more stable joints + firmer contacts, more cost.
   * The ragdoll's PD "muscles" are dt-scaled (substep-invariant), so raising this tightens joints
   * and reduces tunneling/jitter without changing the tuned fall behavior. It only runs while a
   * ragdoll is active (during tackles), so the extra cost is brief. */
  substeps = 4;
  private readonly baseSubsteps = 4;
  private highSubstepRefs = 0;

  /** Ragdolls need tighter joints (8 substeps). Refcounted: each active ragdoll acquires, and the
   *  baseline is only restored once ALL release. Previously each ragdoll saved/restored a snapshot of
   *  the shared `substeps`, so overlapping tackles clobbered each other and left it stuck at 8 forever
   *  (2x physics cost for the rest of the game). */
  acquireHighSubsteps(): void {
    this.highSubstepRefs++;
    this.substeps = 8;
  }
  releaseHighSubsteps(): void {
    this.highSubstepRefs = Math.max(0, this.highSubstepRefs - 1);
    if (this.highSubstepRefs === 0) this.substeps = this.baseSubsteps;
  }

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
    // The ground must cover the WHOLE field: players (and their ragdolls) live at world
    // X 0..~120, Z 0..~53 (field pixels * 1/PX_PER_YARD). A ground centered on the origin must
    // therefore be large enough to reach past midfield in every direction — a too-small slab
    // let bodies tackled past the 50 fall straight through (and jitter off its edge). The top
    // surface sits at y=0 (half-height 0.5, translated down 0.5).
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(250, 0.5, 250).setTranslation(0, -0.5, 0).setFriction(1.4),
      body,
    );
    this.groundBody = body;
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
