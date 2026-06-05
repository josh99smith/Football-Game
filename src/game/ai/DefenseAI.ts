import type { Player } from "../entities/Player";
import type { Ball } from "../entities/Ball";
import type { DefenseScheme } from "../Playbook";
import { addSteer, pursue, seek, separation } from "./Steering";
import { type Vec2 } from "../../engine/math/Vec2";

export interface PlayContext {
  offense: Player[];
  defense: Player[];
  ball: Ball;
  qb: Player | null;
  carrier: Player | null;
  losX: number;
  /** Offense attack direction (+1 toward +X, -1 toward -X). */
  dir: number;
  isRun: boolean;
}

/** Resolve per-defender jobs at the snap based on the chosen scheme. */
export function assignDefense(ctx: PlayContext, scheme: DefenseScheme): void {
  const { defense, offense } = ctx;
  const dl = defense.filter((p) => p.role === "DL");
  const lb = defense.filter((p) => p.role === "LB");
  const db = defense.filter((p) => p.role === "DB");
  const wrs = offense.filter((p) => p.role === "WR").sort((a, b) => a.pos.y - b.pos.y);
  const hb = offense.find((p) => p.role === "HB") ?? null;
  const dbSorted = [...db].sort((a, b) => a.pos.y - b.pos.y);

  const manCoverWRs = () => {
    for (let i = 0; i < dbSorted.length; i++) {
      const target = wrs[i] ?? wrs[wrs.length - 1] ?? null;
      dbSorted[i].job = "cover";
      dbSorted[i].assignment = target;
    }
  };

  // Defensive line almost always rushes.
  for (const d of dl) d.job = "rush";

  if (scheme === "cover") {
    manCoverWRs();
    if (lb[0]) {
      lb[0].job = "cover";
      lb[0].assignment = hb;
    }
    if (lb[1]) {
      lb[1].job = "zone";
      lb[1].zonePoint = { x: ctx.losX + ctx.dir * 8 * 16, y: ctx.defense[0].pos.y };
    }
  } else if (scheme === "blitz") {
    for (const l of lb) l.job = "rush";
    // Two corners man the outside WRs, the safety plays deep center.
    if (dbSorted[0]) {
      dbSorted[0].job = "cover";
      dbSorted[0].assignment = wrs[0] ?? hb;
    }
    if (dbSorted[2]) {
      dbSorted[2].job = "cover";
      dbSorted[2].assignment = wrs[wrs.length - 1] ?? hb;
    }
    if (dbSorted[1]) {
      dbSorted[1].job = "zone";
      dbSorted[1].zonePoint = { x: ctx.losX + ctx.dir * 18 * 16, y: ctx.defense[0].pos.y };
    }
  } else {
    // spy
    if (lb[0]) {
      lb[0].job = "spy";
      lb[0].assignment = ctx.qb;
    }
    if (lb[1]) {
      lb[1].job = "zone";
      lb[1].zonePoint = { x: ctx.losX + ctx.dir * 6 * 16, y: ctx.defense[0].pos.y };
    }
    manCoverWRs();
  }
}

const CENTER_Y_FALLBACK = 0;

/** Per-frame: set `desired` for every non-human-controlled defender. */
export function updateDefense(ctx: PlayContext, controlled: Player | null): void {
  const { defense, ball, qb, carrier } = ctx;

  // If the ball is loose or there's a live runner past the line, everyone hunts it.
  const huntTarget: Vec2 | null = ball.state === "loose"
    ? ball.pos
    : carrier
      ? carrier.pos
      : null;
  const carrierIsRunning =
    !!carrier && (ctx.isRun || carrier.role !== "QB" || pastLine(carrier, ctx));

  for (const d of defense) {
    if (d === controlled || d.isDown) continue;
    let steer: Vec2 = { x: 0, y: 0 };

    if (ball.state === "loose" && huntTarget) {
      steer = seek(d.pos, huntTarget);
      d.turbo = true;
    } else if (carrierIsRunning && carrier) {
      // Take a proper pursuit angle: aim at the point where this defender can actually meet the
      // carrier (a real interception solve), kept goal-side so he cuts the runner off and squares
      // up instead of trailing. Sprint to close; ease off only when right on top to make the hit.
      steer = seek(d.pos, interceptPoint(d, carrier, ctx));
      d.turbo = dist2(d.pos, carrier.pos) > 30 * 30;
    } else {
      switch (d.job) {
        case "rush": {
          const t = qb ?? carrier;
          steer = t ? seek(d.pos, t.pos) : { x: ctx.dir, y: 0 };
          // Rushers do NOT sprint — that keeps a throwable pocket for the QB.
          d.turbo = false;
          break;
        }
        case "cover": {
          // Break hard on the ball once it's in the air (jump the route).
          if (ball.state === "inAir") {
            steer = seek(d.pos, ball.target);
            d.turbo = true;
            break;
          }
          if (d.assignment && !d.assignment.isDown) {
            const a = d.assignment;
            // Mirror the receiver, anticipating their movement, with a small goal-side cushion
            // so we keep leverage instead of trailing. Sprint to recover if we've lost a step.
            const lead = pursue(d.pos, a, 0.2);
            const cushion = { x: a.pos.x + ctx.dir * 10, y: a.pos.y };
            steer = addSteer(lead, seek(d.pos, cushion), 0.6);
            d.turbo = dist2(d.pos, a.pos) > 38 * 38; // glued unless beaten, then chase
          } else if (qb) {
            steer = seek(d.pos, qb.pos);
            d.turbo = false;
          }
          break;
        }
        case "spy": {
          const t = carrier ?? qb;
          if (t) {
            // Mirror laterally, hold a contain depth in front of the QB.
            const mirror = { x: d.pos.x, y: t.pos.y };
            steer = seek(d.pos, mirror);
            if (pastLine(t, ctx) || dist2(d.pos, t.pos) < 70 * 70) steer = seek(d.pos, t.pos);
          }
          break;
        }
        case "zone": {
          // Break on the ball in the air like everyone else.
          if (ball.state === "inAir") {
            steer = seek(d.pos, ball.target);
            d.turbo = true;
            break;
          }
          const anchor = d.zonePoint ?? d.home;
          // Drive on the nearest threat entering the zone, else settle on the spot.
          const threat = nearestOffenseTo(ctx, anchor, 150);
          steer = threat ? seek(d.pos, threat.pos) : seek(d.pos, anchor);
          d.turbo = threat != null && dist2(d.pos, threat.pos) > 70 * 70;
          break;
        }
        default:
          steer = qb ? seek(d.pos, qb.pos) : { x: 0, y: 0 };
      }
    }

    // Spread out in coverage, but converge to swarm/gang-tackle a live ball-carrier.
    const sep = separation(d, defense, 26);
    d.desired = addSteer(steer, sep, carrierIsRunning || ball.state === "loose" ? 0.18 : 0.5);

    // Face the play while in coverage so drops/mirrors read as backpedals & shuffles;
    // face movement when rushing or chasing a runner (forward run).
    if (carrierIsRunning || d.job === "rush" || ball.state === "loose") {
      d.lookDir = null;
    } else {
      const t = qb ?? carrier;
      d.lookDir = t ? Math.atan2(t.pos.y - d.pos.y, t.pos.x - d.pos.x) : null;
    }
  }
  void CENTER_Y_FALLBACK;
}

/**
 * Where a defender should aim to cut off the ball carrier. Solves (iteratively) for the point
 * on the carrier's projected path that this defender can reach at the same time — a true pursuit
 * angle — then keeps it goal-side so he gets in front and squares up rather than chasing the hip.
 */
function interceptPoint(d: Player, carrier: Player, ctx: PlayContext): Vec2 {
  const dSpeed = Math.max(60, d.baseSpeed);
  // Converge on the meeting time: t ≈ distance-to-future-spot / defender speed.
  let t = Math.hypot(carrier.pos.x - d.pos.x, carrier.pos.y - d.pos.y) / dSpeed;
  for (let i = 0; i < 3; i++) {
    const fx = carrier.pos.x + carrier.vel.x * t;
    const fy = carrier.pos.y + carrier.vel.y * t;
    t = Math.hypot(fx - d.pos.x, fy - d.pos.y) / dSpeed;
  }
  t = Math.min(t, 1.5); // don't over-project on a far, fast runner
  let px = carrier.pos.x + carrier.vel.x * t;
  const py = carrier.pos.y + carrier.vel.y * t;
  // Leverage: never aim behind the runner — get to the goal side so we cut him off.
  const goalSide = carrier.pos.x + ctx.dir * 12;
  px = ctx.dir > 0 ? Math.max(px, goalSide) : Math.min(px, goalSide);
  return { x: px, y: py };
}

function pastLine(p: Player, ctx: PlayContext): boolean {
  return ctx.dir > 0 ? p.pos.x > ctx.losX + 4 : p.pos.x < ctx.losX - 4;
}

function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function nearestOffenseTo(ctx: PlayContext, point: Vec2, maxDist: number): Player | null {
  let best: Player | null = null;
  let bestD = maxDist * maxDist;
  for (const o of ctx.offense) {
    if (o.isDown || o.job === "block" || o.job === "qb") continue;
    const d = dist2(o.pos, point);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}
