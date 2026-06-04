import type { Player } from "../entities/Player";
import { addSteer, seek, separation } from "./Steering";
import type { PlayContext } from "./DefenseAI";
import { dist, type Vec2 } from "../../engine/math/Vec2";

const ROUTE_REACH = 18; // px proximity to advance to next waypoint

/** Per-frame: set `desired` for every non-human-controlled offensive player. */
export function updateOffense(ctx: PlayContext, controlled: Player | null): void {
  const { offense, carrier } = ctx;
  const carrierRunning = !!carrier && carrier.role !== "QB";

  for (const o of offense) {
    if (o === controlled || o.isDown) continue;
    if (o === carrier) continue; // the ball carrier is driven by player/CPU controller

    // Once a teammate is running with the ball, everyone blocks downfield.
    const job = carrierRunning && o.job !== "qb" ? "block" : o.job;
    let steer: Vec2 = { x: 0, y: 0 };

    switch (job) {
      case "block": {
        const protect = carrier ?? ctx.qb;
        const threat = nearestDefenderTo(ctx, protect ? protect.pos : o.pos);
        if (threat && protect) {
          // Stand between the threat and whoever we're protecting.
          const block: Vec2 = {
            x: threat.pos.x + Math.sign(protect.pos.x - threat.pos.x) * 10,
            y: threat.pos.y,
          };
          steer = seek(o.pos, block);
          o.turbo = dist(o.pos, threat.pos) > 90;
        }
        break;
      }
      case "route": {
        if (o.routeIndex < o.route.length) {
          const wp = o.route[o.routeIndex];
          steer = seek(o.pos, wp);
          if (dist(o.pos, wp) < ROUTE_REACH) o.routeIndex++;
        } else {
          // Route finished: drift to get open away from nearest defender.
          const cover = nearestDefenderTo(ctx, o.pos);
          if (cover && dist(o.pos, cover.pos) < 70) {
            steer = { x: Math.sign(o.pos.x - cover.pos.x) || ctx.dir, y: Math.sign(o.pos.y - cover.pos.y) };
          } else {
            steer = { x: ctx.dir * 0.4, y: 0 };
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
  }
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
