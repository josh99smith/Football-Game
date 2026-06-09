import type { Renderer } from "../../engine/Renderer";
import { clamp, moveToward, type Vec2 } from "../../engine/math/Vec2";

export type TeamId = "HOME" | "AWAY";

export type Role = "QB" | "HB" | "WR" | "OL" | "DL" | "LB" | "DB";

export type PlayerState = "set" | "active" | "contact" | "stumbling" | "tackled" | "celebrate";

export type Gait = "idle" | "jog" | "sprint";

/**
 * Per-frame locomotion state derived from physics (the single source of truth the
 * simulation and the avatar both read, so visuals always track the sim).
 */
export interface LocoState {
  gait: Gait;
  /** Speed magnitude in px/s. */
  speed: number;
  /** Speed normalized to this player's role top speed (0..1). */
  speed01: number;
  /** Smoothed heading in radians (atan2(y,x) convention), drives the model yaw. */
  heading: number;
  /** Movement direction relative to facing (radians, -PI..PI): 0 fwd, ±PI back, ±PI/2 strafe. */
  moveRel: number;
  /** Signed heading change rate this step (rad/s), for banking. */
  turnRate: number;
  /** Fully tackled and on the ground. */
  down: boolean;
  /** Wrapped up in the contact beat (pre-fall). */
  contact: boolean;
  /** Glancing-hit stumble (still upright / in control). */
  stumbling: boolean;
  /** Low-pass-filtered acceleration in FIELD space (px/s^2) — drives the avatar's weight lean
   *  (decelerate ⇒ lean back, cut ⇒ bank into it). */
  accelX: number;
  accelY: number;
}

// Gait hysteresis (normalized speed) — avoids idle<->jog flicker at the boundary.
const JOG_ENTER = 0.14;
const JOG_EXIT = 0.09;
const SPRINT_AT = 0.82;
// Smoothed heading slews toward velocity at this rate (rad/s), scaled by speed so the
// player pivots quickly when slow and carves when sprinting.
const HEADING_TURN_RAD = 12;

/**
 * Per-role base attributes (arcade-tuned, in px/s and px/s^2). Speeds are deliberately
 * moderate for a weightier, more readable pace (slower than a twitch arcade title).
 */
const ROLE_STATS: Record<Role, { speed: number; accel: number; radius: number; strength: number }> = {
  // Skill positions are fast but light; linemen are slow but powerful; QBs are average; the
  // secondary runs with the receivers. `strength` (≈1.0 baseline) drives blocking, shoving in
  // piles, breaking/making tackles, and the tug in the 1-on-1 battle.
  QB: { speed: 150, accel: 1300, radius: 12, strength: 0.92 },
  HB: { speed: 178, accel: 1520, radius: 12, strength: 1.06 },
  WR: { speed: 184, accel: 1460, radius: 11.5, strength: 0.84 },
  OL: { speed: 118, accel: 1020, radius: 14.5, strength: 1.45 },
  DL: { speed: 122, accel: 1080, radius: 14.5, strength: 1.4 },
  LB: { speed: 150, accel: 1250, radius: 13, strength: 1.18 },
  DB: { speed: 174, accel: 1420, radius: 11.5, strength: 0.9 },
};

export const TURBO_MULT = 1.4;
/** Global pace dial: scales every player's top speed (and eases accel) to slow the game down. */
const SPEED_SCALE = 0.86;

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
  /** Position-based power (≈1.0 baseline): blocking, pile shoves, tackle break/make, battle tug. */
  readonly strength: number;

  state: PlayerState = "set";
  hasBall = false;
  controlled = false;
  turbo = false;
  /** Instantaneous velocity angle (kept for 2D render + legacy callers). */
  facing = 0;
  /** Smoothed heading that drives the 3D model yaw and gameplay facing. */
  heading = 0;
  private prevHeading = 0;
  /** When set, the player faces this angle instead of its movement direction
   * (QB faces downfield on the drop; DBs face the offense while backpedaling). */
  lookDir: number | null = null;

  /** Per-frame locomotion state (the single source of truth for animation). */
  readonly loco: LocoState = {
    gait: "idle",
    speed: 0,
    speed01: 0,
    heading: 0,
    moveRel: 0,
    turnRate: 0,
    down: false,
    contact: false,
    stumbling: false,
    accelX: 0,
    accelY: 0,
  };
  /** Previous-frame velocity, for deriving acceleration in updateLoco (no-alloc). */
  private readonly _prevVel: Vec2 = { x: 0, y: 0 };

  /** Countdown after being tackled before the player is "down" cleanup happens. */
  tackledTimer = 0;
  /** Brief windows used by AI/cuts. */
  jukeTimer = 0;
  /** Active dive/lunge window (carrier dive or defender dive-tackle). */
  diveTimer = 0;
  /** This lunge is a committed BIG HIT (hit-stick): devastating on contact, a whiff if it misses. */
  bigHitArmed = false;
  /** Receiver just made a route break — burst open while the DB reacts late. */
  cutTimer = 0;
  /** Wrapped-up beat: carrier + tackler slide/fall together before the whistle. */
  contactTimer = 0;
  /** Shared drift velocity used during the contact beat. */
  contactVel: Vec2 = { x: 0, y: 0 };
  /** Glancing-hit stumble window. */
  stumbleTimer = 0;
  /** Turn-rate multiplier (the human-controlled player turns/cuts more sharply than the AI). */
  agility = 1;
  /** Juke/cut lean signal (-1..1), consumed by the avatar for an extra bank. */
  leanTarget = 0;
  /** One-shot animation trigger consumed by the renderer. */
  animEvent: "pass" | "catch" | "juke" | "spin" | "stiffArm" | "tackle" | "tackleMade" | "swat" | "celebrate" | null = null;

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
    // A small per-player variance so individuals differ a touch (a fast QB, a bruising back).
    const vary = 1 + (Math.random() * 2 - 1) * 0.045;
    this.baseSpeed = s.speed * SPEED_SCALE * vary;
    this.accel = s.accel * (0.5 + 0.5 * SPEED_SCALE); // ease accel down a touch too, keeps it crisp
    this.radius = s.radius;
    this.strength = s.strength * (1 + (Math.random() * 2 - 1) * 0.06);
  }

  /**
   * "Out of the play" for AI/sim purposes. Includes the contact (wrap-up) beat so
   * defenders/blockers disengage a wrapped carrier; the renderer distinguishes the
   * wrap-up from a finished tackle via `loco.contact` vs `loco.down`.
   */
  get isDown(): boolean {
    return this.state === "tackled" || this.state === "contact";
  }

  /** Speed multiplier from turbo and (optionally) team on-fire bonus. */
  speedFor(turbo: boolean, onFire: boolean): number {
    let m = 1;
    if (turbo) m *= TURBO_MULT;
    if (onFire) m *= 1.15; // ON FIRE: the whole team runs hotter
    return this.baseSpeed * m;
  }

  /**
   * Integrate movement toward `desired` direction at the given target speed.
   * `accelMul` boosts responsiveness (used to make the human-controlled player
   * feel tight); braking is stronger than acceleration so stops/cuts are crisp.
   */
  step(dt: number, targetSpeed: number, accelMul = 1): void {
    if (this.jukeTimer > 0) this.jukeTimer -= dt;
    if (this.diveTimer > 0) this.diveTimer -= dt;
    if (this.cutTimer > 0) this.cutTimer -= dt;

    if (this.state === "tackled") {
      this.tackledTimer -= dt;
      if (this.tackledTimer > 0) {
        // Decelerate any residual momentum while down.
        this.vel.x = moveToward(this.vel.x, 0, this.accel * 2 * dt);
        this.vel.y = moveToward(this.vel.y, 0, this.accel * 2 * dt);
        this.pos.x += this.vel.x * dt;
        this.pos.y += this.vel.y * dt;
        this.updateLoco(dt);
        return;
      }
      // Timer elapsed: scramble back up and rejoin the play (clears loco.down so the avatar stands).
      // The ball carrier's tackle has already ended the play by now, so this only revives the
      // knocked-down (blocked / whiffed-tackle / gang-tackle) players who were stuck lying there.
      this.state = "active";
    }

    if (this.state === "contact") {
      // Wrapped up: blend toward the shared fall momentum and slide down together.
      this.contactTimer -= dt;
      this.vel.x = moveToward(this.vel.x, this.contactVel.x, this.accel * 1.5 * dt);
      this.vel.y = moveToward(this.vel.y, this.contactVel.y, this.accel * 1.5 * dt);
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      if (this.contactTimer <= 0) {
        this.state = "tackled";
        this.tackledTimer = Math.max(this.tackledTimer, 0.9);
        this.hasBall = false;
      }
      this.updateLoco(dt);
      return;
    }

    if (this.state === "stumbling") {
      this.stumbleTimer -= dt;
      if (this.stumbleTimer <= 0) this.state = "active";
    }

    const dl = Math.hypot(this.desired.x, this.desired.y);
    const moving = dl > 0.01;
    const dirX = moving ? this.desired.x / dl : 0;
    const dirY = moving ? this.desired.y / dl : 0;
    const desiredVx = dirX * targetSpeed;
    const desiredVy = dirY * targetSpeed;

    // Brake harder than we accelerate; brake hardest when there's no input at all.
    const baseA = this.accel * accelMul * dt;
    const ax = this.brakeStep(this.vel.x, desiredVx, baseA, moving);
    const ay = this.brakeStep(this.vel.y, desiredVy, baseA, moving);
    this.vel.x = moveToward(this.vel.x, desiredVx, ax);
    this.vel.y = moveToward(this.vel.y, desiredVy, ay);
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;

    this.updateLoco(dt);
  }

  /**
   * Derive the per-frame locomotion state from physics: smoothed heading (rate-limited
   * so the player carves instead of teleport-turning), gait with hysteresis, and the
   * down/contact/stumble flags. This is the single source the avatar reads.
   */
  private updateLoco(dt: number): void {
    const speed = Math.hypot(this.vel.x, this.vel.y);
    const top = this.baseSpeed * TURBO_MULT;
    const speed01 = clamp(speed / top, 0, 1);

    // Face `lookDir` if set (e.g. QB downfield / DB at the offense), else the velocity
    // direction. Heading slews so the body carves; turn faster when slow.
    const moveAng = speed > 8 ? Math.atan2(this.vel.y, this.vel.x) : this.heading;
    const target = this.lookDir != null ? this.lookDir : moveAng;
    if (speed > 8 || this.lookDir != null) {
      let d = target - this.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      // Turn faster when slow; the high-speed throttle is gentler now (0.75 vs 0.5) so cuts and
      // reversals read quickly, and the human-controlled player (agility>1) carves sharper still.
      const maxTurn = HEADING_TURN_RAD * this.agility * (0.75 + 0.6 * (1 - speed01)) * dt;
      this.heading += clamp(d, -maxTurn, maxTurn);
    }
    // Movement direction relative to where we're facing (drives fwd/back/strafe blend).
    let rel = moveAng - this.heading;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    this.loco.moveRel = speed > 8 ? rel : 0;
    let turn = this.heading - this.prevHeading;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    this.prevHeading = this.heading;
    this.facing = this.heading; // keep legacy consumers (2D render) in sync

    const lo = this.loco;
    lo.speed = speed;
    lo.speed01 = speed01;
    lo.heading = this.heading;
    lo.turnRate = turn / Math.max(dt, 1 / 120);
    lo.down = this.state === "tackled";
    lo.contact = this.state === "contact";
    lo.stumbling = this.state === "stumbling";
    // Low-passed acceleration for the avatar's weight lean (the brief's ~4/T critically-damped
    // filter, T≈0.12s). Zeroed while down/contact so a state change can't spike the lean.
    if (lo.down || lo.contact) {
      lo.accelX = 0;
      lo.accelY = 0;
    } else {
      const inv = 1 / Math.max(dt, 1 / 120);
      const rawAx = (this.vel.x - this._prevVel.x) * inv;
      const rawAy = (this.vel.y - this._prevVel.y) * inv;
      const k = clamp((4 / 0.12) * dt, 0, 1);
      lo.accelX += (rawAx - lo.accelX) * k;
      lo.accelY += (rawAy - lo.accelY) * k;
    }
    this._prevVel.x = this.vel.x;
    this._prevVel.y = this.vel.y;
    // Gait with hysteresis.
    const wasJogging = lo.gait !== "idle";
    if (this.turbo || speed01 > SPRINT_AT) lo.gait = "sprint";
    else if (speed01 > JOG_ENTER || (wasJogging && speed01 > JOG_EXIT)) lo.gait = "jog";
    else lo.gait = "idle";

    if (this.leanTarget !== 0) this.leanTarget = moveToward(this.leanTarget, 0, dt * 3);
  }

  /** Enter the wrap-up beat: slide/fall toward a shared momentum, then go down. */
  enterContact(driftVx: number, driftVy: number, seconds: number): void {
    this.state = "contact";
    this.contactTimer = seconds;
    this.contactVel.x = driftVx;
    this.contactVel.y = driftVy;
  }

  /** Glancing hit: stay upright but lose a beat (and lean). */
  enterStumble(seconds: number): void {
    if (this.state !== "active") return;
    this.state = "stumbling";
    this.stumbleTimer = seconds;
  }

  /** True while staggering from a glancing hit. */
  get isStumbling(): boolean {
    return this.state === "stumbling";
  }

  /** Pick an acceleration rate: faster when decelerating / reversing for snappier control. */
  private brakeStep(v: number, target: number, baseA: number, moving: boolean): number {
    if (!moving) return baseA * 2.6; // no input: stop quickly
    // Decelerating toward target (opposite sign or shrinking magnitude) gets a little extra grip
    // so stops/cuts stay crisp — but not so much that changing direction feels sluggish.
    const decel = Math.sign(target - v) !== Math.sign(v) || Math.abs(target) < Math.abs(v);
    return decel ? baseA * 1.5 : baseA;
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
