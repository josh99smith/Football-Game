import type { Player } from "./entities/Player";
import type { Ball } from "./entities/Ball";
import { dist, type Vec2 } from "../engine/math/Vec2";

export interface CatchResult {
  caught?: Player;
  intercepted?: Player;
  incomplete?: boolean;
  /** Defender who broke the pass up (for the ball-swat animation). */
  swatBy?: Player;
}

// Catching is resolved by the ball's real 3D proximity to a PLAYER (not its target spot): the ball
// has to actually arrive in a player's reach and be at a catchable height before anything triggers.
const CATCH_REACH = 28;       // horizontal px a player can reach to the ball (~2 yd; +arm)
const CATCH_REACH_INTENDED = 42; // the targeted receiver reaches a bit further (benefit of the doubt)
const CATCH_HEIGHT = 70;      // ball must have descended below this height to be catchable

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

  // Lead the receiver by roughly the ball's flight time (farther = more lead), so with the tighter
  // proximity catch the ball arrives right where the receiver is running, not behind him.
  const reach = Math.hypot(best.pos.x - qb.pos.x, best.pos.y - qb.pos.y);
  const leadT = Math.min(0.95, Math.max(0.32, reach / 620));
  const lead: Vec2 = { x: best.pos.x + best.vel.x * leadT, y: best.pos.y + best.vel.y * leadT };
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

/** Field play bounds (world px) — a ball/catch outside these is out of bounds. */
export interface FieldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
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
  bounds: FieldBounds,
  intended: Player | null = null,
): CatchResult | null {
  if (ball.state !== "inAir") return null;

  // The ball can only be caught once it has DESCENDED into the catchable height band — until then it
  // sails over everyone (no early magnet catches while it's still up at its apex).
  const ballLow = ball.z < CATCH_HEIGHT;

  // Who can actually reach the ball right now (real proximity to the PLAYER, not the target spot)?
  // The targeted receiver reaches a little further. Nobody in reach + still airborne ⇒ keep flying.
  let rcv: Player | null = null;
  let dRcv = Infinity;
  if (ballLow) {
    if (intended && !intended.isDown && intended.job !== "block") {
      const d = dist(ball.pos, intended.pos);
      if (d < CATCH_REACH_INTENDED) { rcv = intended; dRcv = d; }
    }
    if (!rcv) {
      rcv = nearestInRange(ball.pos, offense.filter((p) => p !== ball.thrownBy && p.job !== "block"), CATCH_REACH);
      if (rcv) dRcv = dist(ball.pos, rcv.pos);
    }
  }
  let def: Player | null = null;
  let dDef = Infinity;
  if (ballLow) {
    def = nearestInRange(ball.pos, defense, CATCH_REACH);
    if (def) dDef = dist(ball.pos, def.pos);
  }

  // Nobody can reach it yet: let it keep traveling; only an actual landing is incomplete.
  if (!rcv && !def) return landed ? { incomplete: true } : null;

  // A ball arriving out of bounds can't be caught or picked — it's incomplete (no back-of-end-zone TDs).
  if (
    ball.pos.x < bounds.minX || ball.pos.x > bounds.maxX ||
    ball.pos.y < bounds.minY || ball.pos.y > bounds.maxY
  ) {
    return { incomplete: true };
  }

  if (def && rcv) {
    // The defender must clearly beat the receiver to the ball; the targeted man gets the benefit.
    const margin = rcv === intended ? 14 : 3;
    if (dDef < dRcv - margin) {
      return Math.random() < pickChance ? { intercepted: def } : { incomplete: true, swatBy: def };
    }
    return Math.random() < pickChance * 0.2 ? { intercepted: def } : { caught: rcv };
  }
  if (rcv) return { caught: rcv };
  return Math.random() < pickChance ? { intercepted: def! } : { incomplete: true, swatBy: def! };
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
