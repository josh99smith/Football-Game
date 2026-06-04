import type { Player } from "./entities/Player";
import type { Ball } from "./entities/Ball";
import { dist, type Vec2 } from "../engine/math/Vec2";

export interface CatchResult {
  caught?: Player;
  intercepted?: Player;
  incomplete?: boolean;
}

const CATCH_RADIUS = 44; // generous so well-thrown balls are actually caught
const CATCH_HEIGHT = 70; // ball must be low enough to be catchable

/**
 * Pick the receiver to throw to. If the QB is "aiming" (joystick deflected), choose
 * the eligible receiver best aligned with that direction; otherwise the most open
 * receiver downfield. Returns the receiver and a lead point to throw to.
 */
export function chooseTarget(
  qb: Player,
  receivers: Player[],
  defense: Player[],
  dir: number,
  aim: Vec2,
): { receiver: Player; point: Vec2 } | null {
  const eligible = receivers.filter((r) => !r.isDown && r.job !== "block" && r.role !== "QB");
  if (eligible.length === 0) return null;

  const aiming = Math.hypot(aim.x, aim.y) > 0.4;
  let best: Player | null = null;
  let bestScore = -Infinity;

  for (const rcv of eligible) {
    const toX = rcv.pos.x - qb.pos.x;
    const toY = rcv.pos.y - qb.pos.y;
    const d = Math.hypot(toX, toY) || 1;
    const openness = nearestDefDist(rcv, defense); // bigger = more open
    let score = openness * 0.6;

    // Prefer downfield (in attack direction) targets.
    score += (dir > 0 ? toX : -toX) * 0.05;

    if (aiming) {
      const align = (toX / d) * aim.x + (toY / d) * aim.y; // -1..1
      score += align * 120;
    }
    if (score > bestScore) {
      bestScore = score;
      best = rcv;
    }
  }
  if (!best) return null;

  // Lead the receiver a touch based on its velocity.
  const lead: Vec2 = { x: best.pos.x + best.vel.x * 0.25, y: best.pos.y + best.vel.y * 0.25 };
  return { receiver: best, point: lead };
}

function nearestDefDist(p: Player, defense: Player[]): number {
  let m = Infinity;
  for (const d of defense) {
    if (d.isDown) continue;
    const dd = dist(p.pos, d.pos);
    if (dd < m) m = dd;
  }
  return m === Infinity ? 999 : m;
}

/**
 * Resolve a ball in flight against nearby players. Call each frame while inAir.
 * Returns a result when the ball is caught/picked/incomplete, else null.
 * `pickChance` (0..1) scales how aggressively defenders snag interceptions.
 */
export function resolveAir(
  ball: Ball,
  offense: Player[],
  defense: Player[],
  landed: boolean,
  pickChance: number,
): CatchResult | null {
  if (ball.state !== "inAir") return null;

  // Only contest the ball as it ARRIVES (past the apex / near the target). This stops
  // rushers next to the QB from "catching" the pass the instant it's released.
  const arriving = ball.flightProgress > 0.5 || ball.distToTarget < 60;
  const reachable = arriving && ball.z < CATCH_HEIGHT;

  if (reachable) {
    const def = nearestInRange(ball.pos, defense, CATCH_RADIUS);
    const rcv = nearestInRange(
      ball.pos,
      offense.filter((p) => p !== ball.thrownBy && p.job !== "block"),
      CATCH_RADIUS,
    );

    // Resolve the first frame anyone can reach the ball, so we never re-roll.
    if (def && rcv) {
      const dDef = dist(ball.pos, def.pos);
      const dRcv = dist(ball.pos, rcv.pos);
      // Defender only wins if clearly closer to the ball than the receiver.
      if (dDef < dRcv - 6) {
        return Math.random() < pickChance ? { intercepted: def } : { incomplete: true };
      }
      // Receiver in position: catch it (tiny contested pick chance).
      return Math.random() < pickChance * 0.25 ? { intercepted: def } : { caught: rcv };
    }
    if (rcv) return { caught: rcv };
    if (def) return Math.random() < pickChance ? { intercepted: def } : { incomplete: true };
  }

  if (landed) return { incomplete: true };
  return null;
}

function nearestInRange(point: Vec2, players: Player[], radius: number): Player | null {
  let best: Player | null = null;
  let bestD = radius;
  for (const p of players) {
    if (p.isDown) continue;
    const d = dist(point, p.pos);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}
