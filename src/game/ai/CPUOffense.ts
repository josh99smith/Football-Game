import type { Player } from "../entities/Player";
import type { PlayContext } from "./DefenseAI";
import { addSteer } from "./Steering";
import { type Vec2 } from "../../engine/math/Vec2";
import { FIELD_WIDTH } from "../Field";

const SIDELINE_MARGIN = 70; // px from a sideline where carriers get pushed back infield

/**
 * Drives the CPU when it has possession: the quarterback's drop/scan/throw/scramble
 * decision, and the ball carrier's open-field running. The throw itself is performed
 * via the `throwFn` callback so the owning state controls ball state + sounds.
 */
export class CPUOffense {
  private timer = 0;
  private decided = false;
  /** Seconds the QB will scan before forcing a throw/scramble (set by difficulty). */
  private patience: number;
  private scrambling = false;

  constructor(difficulty: "rookie" | "pro" | "allpro") {
    this.patience = difficulty === "allpro" ? 3.2 : difficulty === "pro" ? 2.6 : 2.0;
  }

  reset(): void {
    this.timer = 0;
    this.decided = false;
    this.scrambling = false;
  }

  update(
    ctx: PlayContext,
    throwFn: (from: Player, target: Vec2, receiver: Player | null, power?: number) => void,
  ): void {
    this.timer += 1 / 60;
    const carrier = ctx.carrier;
    if (!carrier) return;

    if (carrier.role !== "QB") {
      // Someone is running with the ball — run to daylight.
      steerCarrier(carrier, ctx);
      return;
    }

    // QB has the ball.
    const qb = carrier;
    const pressure = nearestDefender(qb, ctx);
    const pressDist = pressure ? distance(qb.pos, pressure.pos) : Infinity;
    const behindLine = ctx.dir > 0 ? qb.pos.x < ctx.losX : qb.pos.x > ctx.losX;
    const target = bestReceiver(ctx);
    const openD = target ? nearestDefDist(target, ctx) : 0;

    // --- decide what to do with the ball (the QB shouldn't hold it and eat sacks) ---
    if (!this.decided && behindLine) {
      const scanned = this.timer > 0.7;          // let the routes develop before firing
      const pressured = pressDist < 48;
      const imminent = pressDist < 26;            // about to be sacked right now
      if (scanned && target && (openD > 64 || this.timer >= this.patience)) {
        // Fire to the open man the moment there's a window — or by the patience cap, throw it
        // anyway rather than hold (a contested throw still beats a sack).
        return this.fire(qb, target, throwFn);
      }
      if (pressured && scanned) {
        // Under pressure with no clean window: dump it to the most-open man, throw it away if
        // the sack is imminent, otherwise break the pocket and scramble.
        if (target && openD > 36) return this.fire(qb, target, throwFn);
        if (imminent) return this.throwAway(qb, ctx, throwFn);
        this.scrambling = true;
      }
    }

    // --- scramble: run for it, but keep trying to throw (dump-off / throwaway) on the move ---
    if (this.scrambling || (pressDist < 42 && this.timer > 0.6)) {
      this.scrambling = true;
      if (behindLine && !this.decided) {
        if (target && openD > 52) return this.fire(qb, target, throwFn);
        const trapped = pressDist < 30 || qb.pos.y < SIDELINE_MARGIN || qb.pos.y > FIELD_WIDTH - SIDELINE_MARGIN;
        if (trapped) return this.throwAway(qb, ctx, throwFn);
      }
      steerCarrier(qb, ctx);
      return;
    }

    // --- drop back, then settle in the pocket ---
    if (this.timer < 0.6) {
      qb.desired = { x: -ctx.dir, y: 0 };
      qb.turbo = false;
    } else {
      // Slide away from pressure, but toward midfield — never drift toward a sideline.
      const center = FIELD_WIDTH / 2;
      let lat = pressure ? Math.sign(qb.pos.y - pressure.pos.y) * 0.5 : 0;
      if (Math.abs(qb.pos.y - center) > center - SIDELINE_MARGIN) lat = Math.sign(center - qb.pos.y) * 0.5;
      qb.desired = { x: -ctx.dir * 0.15, y: lat };
      qb.turbo = false;
    }
    keepInbounds(qb); // never let the pocket QB drift out of bounds behind the line
  }

  /** Throw to a receiver, leading him; power scales down with distance (bullet -> lob). */
  private fire(
    qb: Player,
    target: Player,
    throwFn: (from: Player, t: Vec2, r: Player | null, p?: number) => void,
  ): void {
    this.decided = true;
    const aim = leadPoint(target);
    const d = distance(qb.pos, aim);
    throwFn(qb, aim, target, Math.max(0.18, Math.min(0.9, 1 - d / 370)));
  }

  /** Spike it away (past the near sideline) to avoid a sack — an incompletion beats a loss. */
  private throwAway(
    qb: Player,
    ctx: PlayContext,
    throwFn: (from: Player, t: Vec2, r: Player | null, p?: number) => void,
  ): void {
    this.decided = true;
    const awayY = qb.pos.y < FIELD_WIDTH / 2 ? -40 : FIELD_WIDTH + 40;
    throwFn(qb, { x: ctx.losX + ctx.dir * 60, y: awayY }, null, 0.6);
  }
}

/** Open-field running: head for the goal while avoiding the nearest defenders. */
export function steerCarrier(carrier: Player, ctx: PlayContext): void {
  const goalX = ctx.dir > 0 ? 1e9 : -1e9;
  let steer: Vec2 = { x: Math.sign(goalX - carrier.pos.x), y: 0 };

  // Repel from nearby defenders, biased to cuts rather than backpedaling.
  let ax = 0;
  let ay = 0;
  let near = Infinity;
  for (const d of ctx.defense) {
    if (d.isDown) continue;
    const dx = carrier.pos.x - d.pos.x;
    const dy = carrier.pos.y - d.pos.y;
    const dd = Math.hypot(dx, dy);
    if (dd < near) near = dd;
    if (dd < 90 && dd > 0) {
      const w = (1 - dd / 90) ** 2;
      ax += (dx / dd) * w * 0.4;
      ay += (dy / dd) * w * 1.3; // emphasize lateral jukes
    }
  }
  steer = addSteer(steer, { x: ax, y: ay });
  // Keep strong forward intent even while evading, so a scramble presses upfield for yards
  // rather than drifting laterally toward the boundary.
  steer.x += ctx.dir * 0.9;
  carrier.desired = steer;
  keepInbounds(carrier);
  carrier.turbo = near > 34;
}

/**
 * Sideline avoidance, AUTHORITATIVE — a CPU carrier must never run himself out of bounds. The
 * closer to a boundary, the harder its desired y is steered infield; inside a hard margin any
 * outward intent is forbidden outright (overriding pressure-avoidance that would shove it out).
 * Applied to the scrambling/running carrier AND the QB dropping back in the pocket.
 */
export function keepInbounds(p: Player): void {
  const center = FIELD_WIDTH / 2;
  const edge = Math.min(p.pos.y, FIELD_WIDTH - p.pos.y);
  if (edge >= SIDELINE_MARGIN) return;
  const inward = p.pos.y < center ? 1 : -1; // +y pushes down from the top edge, etc.
  const urgency = 1 - edge / SIDELINE_MARGIN; // 0 at the margin, 1 at the line
  p.desired.y += inward * (1.0 + 3.0 * urgency);
  if (edge < 30 && Math.sign(p.desired.y) === -inward) p.desired.y = inward * 1.2;
}

function bestReceiver(ctx: PlayContext): Player | null {
  let best: Player | null = null;
  let bestScore = -Infinity;
  for (const o of ctx.offense) {
    if (o.isDown || o.job === "block" || o.role === "QB") continue;
    const open = nearestDefDist(o, ctx);
    const downfield = (ctx.dir > 0 ? o.pos.x - ctx.losX : ctx.losX - o.pos.x) * 0.04;
    const score = open + downfield;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

function leadPoint(p: Player): Vec2 {
  return { x: p.pos.x + p.vel.x * 0.25, y: p.pos.y + p.vel.y * 0.25 };
}

function nearestDefender(p: Player, ctx: PlayContext): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  for (const d of ctx.defense) {
    if (d.isDown) continue;
    const dd = distance(p.pos, d.pos);
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  return best;
}

function nearestDefDist(p: Player, ctx: PlayContext): number {
  const d = nearestDefender(p, ctx);
  return d ? distance(p.pos, d.pos) : 999;
}

function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
