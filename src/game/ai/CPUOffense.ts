import type { Player } from "../entities/Player";
import type { PlayContext } from "./DefenseAI";
import { addSteer } from "./Steering";
import { type Vec2 } from "../../engine/math/Vec2";

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
    const pressured = pressure && distance(qb.pos, pressure.pos) < 42;

    if (this.scrambling || (pressured && this.timer > 0.4)) {
      this.scrambling = true;
      steerCarrier(qb, ctx);
      return;
    }

    // Drop back for the first beat, then settle in the pocket.
    if (this.timer < 0.6) {
      qb.desired = { x: -ctx.dir, y: 0 };
      qb.turbo = false;
    } else {
      qb.desired = { x: -ctx.dir * 0.15, y: pressure ? Math.sign(qb.pos.y - pressure.pos.y) * 0.5 : 0 };
      qb.turbo = false;
    }

    if (!this.decided && this.timer >= this.patience) {
      this.decided = true;
      const target = bestReceiver(ctx);
      if (target) {
        const aim = leadPoint(target);
        // Short routes get fired in (bullet); deep balls are lofted (lob).
        const d = distance(qb.pos, aim);
        const power = Math.max(0.15, Math.min(0.9, 1 - d / 380));
        throwFn(qb, aim, target, power);
      } else {
        this.scrambling = true;
      }
    }
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
  // Keep some forward intent even while evading.
  steer.x += ctx.dir * 0.6;
  carrier.desired = steer;
  carrier.turbo = near > 34;
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
