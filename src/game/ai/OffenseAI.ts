import type { Player } from "../entities/Player";
import { addSteer, seek, separation } from "./Steering";
import type { PlayContext } from "./DefenseAI";
import { dist, type Vec2 } from "../../engine/math/Vec2";
import { FIELD_WIDTH, FIELD_LENGTH } from "../Field";

const ROUTE_REACH = 18; // px proximity to advance to next waypoint
const SIDE_MARGIN = 60; // px from a sideline where receivers steer back inbounds
const BACK_MARGIN = 44; // px from the back of the end zone where routes get cut short

/** Per-frame: set `desired` for every non-human-controlled offensive player. */
export function updateOffense(ctx: PlayContext, controlled: Player | null): void {
  const { offense, carrier } = ctx;
  const carrierRunning = !!carrier && carrier.role !== "QB";
  // A scrambling QB who has crossed the line of scrimmage has committed to running — the play is now
  // a run, so receivers give up their routes and block for him (just like a handoff).
  const qbScramble = !!carrier && carrier.role === "QB" && pastLine(carrier, ctx);
  const blockForCarrier = carrierRunning || qbScramble;

  // Coordinate blocking: assign each blocker to the most dangerous unclaimed rusher
  // (closest to whoever we're protecting), so free blitzers actually get picked up.
  assignBlocks(ctx, blockForCarrier);

  for (const o of offense) {
    if (o === controlled || o.isDown) continue;
    // A live loose ball (fumble): everyone dives on it (but stays inbounds).
    if (ctx.ball.state === "loose") {
      o.desired = seek(o.pos, ctx.ball.pos);
      o.turbo = true;
      keepReceiverInbounds(o, ctx);
      continue;
    }
    if (o === carrier) continue; // the ball carrier is driven by player/CPU controller

    // Once a teammate (or a scrambling QB past the line) is running with the ball, everyone blocks.
    const job = blockForCarrier && o.job !== "qb" ? "block" : o.job;
    let steer: Vec2 = { x: 0, y: 0 };

    switch (job) {
      case "block": {
        const protect = carrier ?? ctx.qb;
        const threat = o.blockTarget && !o.blockTarget.isDown ? o.blockTarget : nearestDefenderTo(ctx, o.pos);
        if (threat && protect) {
          // Get on the protected-player side of the rusher and wall them off.
          const block: Vec2 = {
            x: threat.pos.x + Math.sign(protect.pos.x - threat.pos.x) * 8,
            y: threat.pos.y,
          };
          steer = seek(o.pos, block);
          o.turbo = dist(o.pos, threat.pos) > 55;
        }
        break;
      }
      case "route": {
        const cover = nearestDefenderTo(ctx, o.pos);
        const coverD = cover ? dist(o.pos, cover.pos) : Infinity;
        if (o.routeIndex < o.route.length) {
          const wp = o.route[o.routeIndex];
          const d = dist(o.pos, wp);
          steer = seek(o.pos, wp);
          // Sprint down the stem; gather into the break, then burst out of it (a crisp cut the
          // DB reacts late to). Open up extra hard if a defender is draped on the cut.
          o.turbo = d > 30 || o.cutTimer > 0;
          if (d < ROUTE_REACH) {
            o.routeIndex++;
            o.cutTimer = coverD < 50 ? 0.55 : 0.4;
          }
        } else {
          // Route finished: separate from the nearest defender and keep working to open grass,
          // continuing downfield so the QB has somewhere to lead the throw.
          if (cover && coverD < 95) {
            // Break to the open side (away from the defender's leverage) while pressing downfield.
            const away = Math.sign(o.pos.y - cover.pos.y) || 1;
            steer = { x: ctx.dir * 0.55, y: away };
            o.turbo = true;
            if (coverD < 42) o.cutTimer = 0.3; // shake free
          } else {
            // Uncovered: drive into the open space downfield (give the QB a clean window).
            steer = { x: ctx.dir * 0.7, y: 0 };
            o.turbo = false;
          }
        }
        break;
      }
      case "run":
        // CPU runner is handled by the carrier controller; if not yet carrier, idle.
        steer = { x: ctx.dir * 0.2, y: 0 };
        break;
      default:
        steer = { x: 0, y: 0 };
    }

    const sep = separation(o, offense, 24);
    o.desired = addSteer(steer, sep, 0.35);
    keepReceiverInbounds(o, ctx);
  }
}

/**
 * Keep a route-runner / receiver inbounds and eligible: steer off the sidelines, and — crucially
 * near the goal line — cut the route short instead of running out the back of the end zone, so a
 * deep route in the red zone settles in the end zone (eligible) rather than sailing out of bounds.
 */
function keepReceiverInbounds(o: Player, ctx: PlayContext): void {
  const edgeY = Math.min(o.pos.y, FIELD_WIDTH - o.pos.y);
  if (edgeY < SIDE_MARGIN) {
    const inward = o.pos.y < FIELD_WIDTH / 2 ? 1 : -1;
    o.desired.y += inward * (1 - edgeY / SIDE_MARGIN) * 1.5;
  }
  // Back of the attacking end zone: don't run out the back — pull the route back in.
  const backX = ctx.dir > 0 ? FIELD_LENGTH : 0;
  const edgeX = Math.abs(backX - o.pos.x);
  if (edgeX < BACK_MARGIN) {
    o.desired.x -= ctx.dir * (1 - edgeX / BACK_MARGIN) * 1.8;
  }
}

/** Greedily pair each blocker with the most threatening unclaimed rusher. */
function assignBlocks(ctx: PlayContext, carrierRunning: boolean): void {
  const protect = ctx.carrier ?? ctx.qb;
  const blockers = ctx.offense.filter(
    (o) => !o.isDown && (o.job === "block" || (carrierRunning && o.job !== "qb")),
  );
  for (const b of blockers) b.blockTarget = null;
  if (!protect) return;

  // Threats: defenders nearest to whoever we're protecting come first.
  const threats = ctx.defense
    .filter((d) => !d.isDown)
    .sort((a, b) => dist(a.pos, protect.pos) - dist(b.pos, protect.pos));

  const taken = new Set<Player>();
  for (const threat of threats) {
    let best: Player | null = null;
    let bestD = Infinity;
    for (const b of blockers) {
      if (taken.has(b)) continue;
      const d = dist(b.pos, threat.pos);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    if (best) {
      best.blockTarget = threat;
      taken.add(best);
    }
    if (taken.size === blockers.length) break;
  }
}

/** Has the player crossed the line of scrimmage toward the offense's goal? */
function pastLine(p: Player, ctx: PlayContext): boolean {
  return ctx.dir > 0 ? p.pos.x > ctx.losX + 4 : p.pos.x < ctx.losX - 4;
}

function nearestDefenderTo(ctx: PlayContext, point: Vec2): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  for (const d of ctx.defense) {
    if (d.isDown) continue;
    const dd = (d.pos.x - point.x) ** 2 + (d.pos.y - point.y) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  return best;
}
