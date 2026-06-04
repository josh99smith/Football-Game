import type { Renderer } from "../../engine/Renderer";
import { clamp, moveToward, normalize, type Vec2 } from "../../engine/math/Vec2";

export type TeamId = "HOME" | "AWAY";

export type Role = "QB" | "HB" | "WR" | "OL" | "DL" | "LB" | "DB";

export type PlayerState = "set" | "active" | "tackled" | "celebrate";

/**
 * Per-role base attributes (arcade-tuned, in px/s and px/s^2). Speeds are deliberately
 * moderate for a weightier, more readable pace (slower than a twitch arcade title).
 */
const ROLE_STATS: Record<Role, { speed: number; accel: number; radius: number }> = {
  QB: { speed: 140, accel: 1250, radius: 12 },
  HB: { speed: 158, accel: 1400, radius: 12 },
  WR: { speed: 164, accel: 1350, radius: 11.5 },
  OL: { speed: 124, accel: 1050, radius: 14 },
  DL: { speed: 134, accel: 1150, radius: 14 },
  LB: { speed: 148, accel: 1250, radius: 13 },
  DB: { speed: 162, accel: 1350, radius: 11.5 },
};

export const TURBO_MULT = 1.4;

export class Player {
  pos: Vec2;
  vel: Vec2 = { x: 0, y: 0 };
  /** Desired movement direction this frame (unit-ish), set by AI or human input. */
  desired: Vec2 = { x: 0, y: 0 };

  readonly team: TeamId;
  readonly role: Role;
  readonly number: number;
  readonly baseSpeed: number;
  readonly accel: number;
  readonly radius: number;

  state: PlayerState = "set";
  hasBall = false;
  controlled = false;
  turbo = false;
  facing = 0;

  /** Countdown after being tackled before the player is "down" cleanup happens. */
  tackledTimer = 0;
  /** Brief windows used by AI/cuts. */
  jukeTimer = 0;
  /** Active dive/lunge window (carrier dive or defender dive-tackle). */
  diveTimer = 0;

  // AI scratch fields (used by Offense/Defense AI; harmless when unused).
  /** High-level job assigned by the playbook at snap. */
  job: "qb" | "run" | "route" | "block" | "rush" | "cover" | "spy" | "zone" | "idle" = "idle";
  /** World-space waypoints for receivers (consumed in order). */
  route: Vec2[] = [];
  routeIndex = 0;
  /** Coverage/spy/block assignment (a target player). */
  assignment: Player | null = null;
  blockTarget: Player | null = null;
  /** Zone anchor point for zone defenders. */
  zonePoint: Vec2 | null = null;
  /** Home/spawn spot, used by QB pocket logic and zone recovery. */
  home: Vec2 = { x: 0, y: 0 };

  constructor(team: TeamId, role: Role, number: number, x: number, y: number) {
    this.team = team;
    this.role = role;
    this.number = number;
    this.pos = { x, y };
    const s = ROLE_STATS[role];
    this.baseSpeed = s.speed;
    this.accel = s.accel;
    this.radius = s.radius;
  }

  get isDown(): boolean {
    return this.state === "tackled";
  }

  /** Speed multiplier from turbo and (optionally) team on-fire bonus. */
  speedFor(turbo: boolean, onFire: boolean): number {
    let m = 1;
    if (turbo) m *= TURBO_MULT;
    if (onFire) m *= 1.12;
    return this.baseSpeed * m;
  }

  /** Integrate movement toward `desired` direction at the given target speed. */
  step(dt: number, targetSpeed: number): void {
    if (this.state === "tackled") {
      this.tackledTimer -= dt;
      // Decelerate any residual momentum while down.
      this.vel.x = moveToward(this.vel.x, 0, this.accel * 2 * dt);
      this.vel.y = moveToward(this.vel.y, 0, this.accel * 2 * dt);
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      return;
    }

    const dir = normalize(this.desired);
    const desiredVx = dir.x * targetSpeed;
    const desiredVy = dir.y * targetSpeed;
    const a = this.accel * dt;
    this.vel.x = moveToward(this.vel.x, desiredVx, a);
    this.vel.y = moveToward(this.vel.y, desiredVy, a);
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    const sp = Math.hypot(this.vel.x, this.vel.y);
    if (sp > 8) this.facing = Math.atan2(this.vel.y, this.vel.x);
    if (this.jukeTimer > 0) this.jukeTimer -= dt;
    if (this.diveTimer > 0) this.diveTimer -= dt;
  }

  knockDown(downSeconds = 1.1): void {
    this.state = "tackled";
    this.tackledTimer = downSeconds;
    this.hasBall = false;
    this.turbo = false;
  }

  render(r: Renderer, colors: { jersey: string; trim: string }, onFire: boolean): void {
    const ctx = r.ctx;
    const { x, y } = this.pos;

    if (this.state === "tackled") {
      // Lie flat: an ellipse + a fading "down" marker.
      ctx.globalAlpha = clamp(this.tackledTimer / 1.1, 0.25, 1);
      ctx.fillStyle = colors.jersey;
      ctx.beginPath();
      ctx.ellipse(x, y, this.radius * 1.4, this.radius * 0.7, this.facing, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      return;
    }

    // Shadow.
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(x, y + this.radius * 0.6, this.radius * 1.05, this.radius * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Controlled-player ring.
    if (this.controlled) {
      ctx.strokeStyle = "#ffe24a";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, this.radius + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Body (jersey).
    ctx.fillStyle = onFire ? "#ff6a1e" : colors.jersey;
    ctx.beginPath();
    ctx.arc(x, y, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = colors.trim;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Facing wedge (helmet direction).
    ctx.fillStyle = colors.trim;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(this.facing) * this.radius, y + Math.sin(this.facing) * this.radius);
    ctx.arc(x, y, this.radius, this.facing - 0.5, this.facing + 0.5);
    ctx.closePath();
    ctx.fill();

    // Jersey number.
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${this.radius}px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(this.number), x, y);

    // Ball carrier indicator.
    if (this.hasBall) {
      ctx.fillStyle = "#7a3b12";
      ctx.beginPath();
      ctx.ellipse(x + this.radius * 0.7, y, 5, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
