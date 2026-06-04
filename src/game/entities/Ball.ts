import type { Renderer } from "../../engine/Renderer";
import type { Vec2 } from "../../engine/math/Vec2";
import type { Player } from "./Player";

export type BallState = "held" | "inAir" | "loose";

/**
 * The football. While "held" it tracks its carrier. While "inAir" it follows a
 * parabolic arc (with a visual height z) toward a target landing spot; gameplay
 * code checks for catches/interceptions when it lands or passes near a player.
 */
export class Ball {
  pos: Vec2 = { x: 0, y: 0 };
  vel: Vec2 = { x: 0, y: 0 };
  state: BallState = "held";
  carrier: Player | null = null;

  /** Visual height above the field (for shadow + arc), 0 on the ground. */
  z = 0;
  private vz = 0;

  /** Spin accumulated about the long axis (spiral) / tumble, in radians. */
  spin = 0;
  /** Spin rate (rad/s): high for a tight bullet spiral, lower for a lob. */
  spinRate = 0;
  /** True for a spiral (spins about its long axis); false tumbles end-over-end. */
  spiral = false;

  /** Vertical velocity (px/s, +up) — read by the renderer to nose the ball along its arc. */
  get verticalVel(): number {
    return this.vz;
  }

  /** Landing target while in the air. */
  target: Vec2 = { x: 0, y: 0 };
  /** Who threw it (so we can ignore the thrower for catches and flag INTs). */
  thrownBy: Player | null = null;
  airTime = 0;

  attachTo(p: Player): void {
    this.state = "held";
    this.carrier = p;
    p.hasBall = true;
    this.z = 0;
    this.vz = 0;
    this.spinRate = 0;
  }

  /**
   * Launch a pass toward `target`. `speed` is horizontal px/s, `loft` sets arc height,
   * `spinRate` is the spiral spin in rad/s (tight bullets spin faster than lobs).
   */
  throwTo(from: Player, target: Vec2, speed: number, loft = 1, spinRate = 34): void {
    this.state = "inAir";
    this.thrownBy = from;
    this.carrier = null;
    from.hasBall = false;
    this.pos = { x: from.pos.x, y: from.pos.y };
    this.target = { x: target.x, y: target.y };
    const dx = target.x - from.pos.x;
    const dy = target.y - from.pos.y;
    const dist = Math.hypot(dx, dy) || 1;
    const t = dist / speed; // time to reach target
    this.vel.x = dx / t;
    this.vel.y = dy / t;
    // Arc: z follows a parabola peaking mid-flight.
    this.airTime = 0;
    this.z = 0;
    this.vz = (loft * 9.8 * 22 * t) / 2; // tuned gravity so it lands ~ at target time
    this.flightTime = t;
    this.gravity = this.vz / (t / 2);
    // A thrown pass spins as a tight spiral about its long (nose) axis.
    this.spiral = true;
    this.spinRate = spinRate;
    this.spin = 0;
  }

  flightTime = 0;
  private gravity = 0;

  /** 0 at release, 1 at the landing target. */
  get flightProgress(): number {
    return this.flightTime > 0 ? this.airTime / this.flightTime : 1;
  }

  /** Distance (px) from the ball to its landing target. */
  get distToTarget(): number {
    return Math.hypot(this.target.x - this.pos.x, this.target.y - this.pos.y);
  }

  /** Returns true the frame the ball reaches the ground/target (caller resolves outcome). */
  update(dt: number): boolean {
    if (this.state === "held" && this.carrier) {
      // Sit just ahead of the carrier on their facing side.
      this.pos.x = this.carrier.pos.x;
      this.pos.y = this.carrier.pos.y;
      this.z = 0;
      return false;
    }
    if (this.state === "inAir") {
      this.airTime += dt;
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      this.vz -= this.gravity * dt;
      this.z += this.vz * dt;
      this.spin += this.spinRate * dt;
      if (this.z < 0) this.z = 0;
      if (this.airTime >= this.flightTime) {
        this.z = 0;
        return true; // landed
      }
    }
    if (this.state === "loose") {
      this.spin += this.spinRate * dt;
      // Bouncing projectile: gravity on height, damped bounces, ground friction.
      this.vz -= 540 * dt;
      this.z += this.vz * dt;
      if (this.z <= 0) {
        this.z = 0;
        if (this.vz < -25) {
          this.vz = -this.vz * 0.46; // bounce
          this.vel.x *= 0.6;
          this.vel.y *= 0.6;
        } else {
          this.vz = 0;
        }
      }
      const d = Math.exp(-1.4 * dt);
      this.vel.x *= d;
      this.vel.y *= d;
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
    }
    return false;
  }

  becomeLoose(vx: number, vy: number, vz = 150): void {
    this.state = "loose";
    this.carrier = null;
    this.vel.x = vx;
    this.vel.y = vy;
    this.vz = vz;
    // A loose ball tumbles end-over-end rather than spiraling.
    this.spiral = false;
    this.spinRate = 12 + Math.hypot(vx, vy) * 0.03;
  }

  render(r: Renderer): void {
    const ctx = r.ctx;
    if (this.state === "held") return; // drawn via carrier indicator
    // Shadow on the ground.
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(this.pos.x, this.pos.y, 5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Ball lifted by z.
    const drawY = this.pos.y - this.z;
    ctx.fillStyle = "#8a4b22";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(this.pos.x, drawY, 7, 4.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
