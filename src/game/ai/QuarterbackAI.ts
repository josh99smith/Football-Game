import type { Player } from "../entities/Player";
import type { PlayContext } from "./DefenseAI";
import { type Vec2 } from "../../engine/math/Vec2";
import { FIELD_WIDTH } from "../Field";
import { steerCarrier, keepInbounds } from "./CPUOffense";

type Difficulty = "rookie" | "pro" | "allpro";

/** A scored read on a receiver: where to throw and how good the throw is. */
interface Read {
  rcv: Player;
  aim: Vec2; // anticipated catch point (the receiver led by ball flight time)
  sep: number; // anticipated separation from the nearest defender at the catch point
  laneRisk: number; // 0 (clean lane) .. 1 (a defender sitting in the throwing lane)
  value: number; // overall desirability
}

const SIDELINE_MARGIN = 70;
const THROW_SPEED = 380; // px/s, used to estimate flight time for anticipation

/**
 * The CPU quarterback's brain. Each frame it drops back / holds the pocket, runs a read
 * progression (anticipating where each receiver will be open and whether the throwing lane is
 * clean), and decides to throw, check down, throw it away, or scramble. The goal: get the ball
 * out on time and avoid sacks, while not forcing it into coverage.
 */
export class QuarterbackAI {
  private t = 0;
  private decided = false;
  private scrambling = false;
  private readonly maxHold: number; // hard deadline to get rid of the ball
  private readonly dropTime = 0.55; // initial three-step drop
  private readonly poise: number; // composure: how clean a window a skilled QB waits for (0..1)

  constructor(diff: Difficulty) {
    this.maxHold = diff === "allpro" ? 3.4 : diff === "pro" ? 2.9 : 2.3;
    this.poise = diff === "allpro" ? 1 : diff === "pro" ? 0.7 : 0.45;
  }

  reset(): void {
    this.t = 0;
    this.decided = false;
    this.scrambling = false;
  }

  /** True once the ball is gone (so the owning controller stops driving the QB as a passer). */
  get released(): boolean {
    return this.decided;
  }

  update(
    ctx: PlayContext,
    throwFn: (from: Player, target: Vec2, receiver: Player | null, power?: number) => void,
  ): void {
    if (this.decided) return;
    this.t += 1 / 60;
    const qb = ctx.carrier;
    if (!qb) return;

    const behindLine = ctx.dir > 0 ? qb.pos.x < ctx.losX : qb.pos.x > ctx.losX;
    const rush = nearestDefender(qb, ctx);
    const pressDist = rush ? dist(qb.pos, rush.pos) : Infinity;
    const pressured = pressDist < 52;
    const imminent = pressDist < 24; // about to be sacked this instant

    const read = this.read(qb, ctx);

    // If he's scrambled across the line he can't throw forward — just run it.
    if (!behindLine) {
      this.scrambling = true;
      this.scramble(qb, ctx, read, throwFn, pressDist);
      return;
    }

    // --- throw on rhythm ---
    if (this.t > this.dropTime * 0.7) {
      // Required separation to pull the trigger: tighter early and for a poised QB, looser as the
      // play ages and as pressure mounts. He won't throw into a contested lane unless forced.
      const need = Math.max(24, (40 + 28 * this.poise) - this.t * 7 - (pressured ? 20 : 0));
      if (read && read.laneRisk < 0.55 && read.sep > need) return this.fire(qb, read, throwFn);
      // Play-clock deadline: take the best available rather than hold for a sack.
      if (this.t >= this.maxHold && read) return this.fire(qb, read, throwFn);
    }

    // --- pressure response: check down, throw away, or break the pocket ---
    if (pressured && this.t > 0.35) {
      if (read && read.sep > 30 && read.laneRisk < 0.8) return this.fire(qb, read, throwFn); // dump-off
      if (imminent) return this.throwAway(qb, ctx, throwFn); // get rid of it to avoid the sack
      if (pressDist < 42) this.scrambling = true; // pocket collapsing -> escape
    }

    if (this.scrambling) {
      this.scramble(qb, ctx, read, throwFn, pressDist);
      return;
    }

    // --- pocket presence ---
    this.pocket(qb, ctx, rush, pressDist);
  }

  /** Run a progression read: score every eligible receiver by anticipated openness, depth, and
   *  how clean the throwing lane is. Returns the best option (or null). */
  private read(qb: Player, ctx: PlayContext): Read | null {
    let best: Read | null = null;
    for (const o of ctx.offense) {
      if (o.isDown || o.role === "QB" || o.job === "block") continue;
      const d = dist(qb.pos, o.pos) || 1;
      const flight = Math.min(1.3, d / THROW_SPEED);
      // Lead the receiver to where he'll be when the ball arrives.
      const aim = { x: o.pos.x + o.vel.x * flight, y: o.pos.y + o.vel.y * flight };
      // Separation at that catch point (defenders projected forward too), plus lane risk: a
      // defender sitting in the qb->aim throwing lane is a jump-the-route pick waiting to happen.
      let sep = 999;
      let laneRisk = 0;
      for (const def of ctx.defense) {
        if (def.isDown) continue;
        const fx = def.pos.x + def.vel.x * flight;
        const fy = def.pos.y + def.vel.y * flight;
        sep = Math.min(sep, Math.hypot(fx - aim.x, fy - aim.y));
        const lane = distToSegment(def.pos, qb.pos, aim);
        if (lane < 36) laneRisk = Math.max(laneRisk, 1 - lane / 36);
      }
      const depth = ctx.dir > 0 ? aim.x - ctx.losX : ctx.losX - aim.x;
      const value = sep + Math.max(0, depth) * 0.03 - laneRisk * 45;
      if (!best || value > best.value) best = { rcv: o, aim, sep, laneRisk, value };
    }
    return best;
  }

  /** Throw to the read, leading him; power scales bullet (short) -> lob (deep). */
  private fire(
    qb: Player,
    read: Read,
    throwFn: (from: Player, t: Vec2, r: Player | null, p?: number) => void,
  ): void {
    this.decided = true;
    const d = dist(qb.pos, read.aim);
    throwFn(qb, read.aim, read.rcv, Math.max(0.2, Math.min(0.92, 1 - d / 360)));
  }

  /** Spike it away past the near sideline — an incompletion beats a sack. */
  private throwAway(
    qb: Player,
    ctx: PlayContext,
    throwFn: (from: Player, t: Vec2, r: Player | null, p?: number) => void,
  ): void {
    this.decided = true;
    const awayY = qb.pos.y < FIELD_WIDTH / 2 ? -40 : FIELD_WIDTH + 40;
    throwFn(qb, { x: ctx.losX + ctx.dir * 60, y: awayY }, null, 0.6);
  }

  /** Drop back, then keep a throwing platform: climb the pocket against edge pressure, slide
   *  away from interior pressure (toward midfield), never drifting out of bounds. */
  private pocket(qb: Player, ctx: PlayContext, rush: Player | null, pressDist: number): void {
    if (this.t < this.dropTime) {
      qb.desired = { x: -ctx.dir, y: 0 };
    } else if (rush && pressDist < 78) {
      const lat = Math.sign(qb.pos.y - rush.pos.y) || 1;
      const rusherHasDepth = ctx.dir > 0 ? rush.pos.x < qb.pos.x : rush.pos.x > qb.pos.x;
      // If the rusher got behind/even (edge), step UP into the pocket; otherwise slide laterally.
      qb.desired = { x: rusherHasDepth ? ctx.dir * 0.45 : -ctx.dir * 0.1, y: lat * 0.55 };
    } else {
      qb.desired = { x: -ctx.dir * 0.12, y: 0 };
    }
    qb.turbo = false;
    keepInbounds(qb);
  }

  /** Scramble: run for yards, but keep the eyes up — dump to an open man or throw it away when
   *  trapped, rather than running into a sack or out of bounds. */
  private scramble(
    qb: Player,
    ctx: PlayContext,
    read: Read | null,
    throwFn: (from: Player, t: Vec2, r: Player | null, p?: number) => void,
    pressDist: number,
  ): void {
    const behindLine = ctx.dir > 0 ? qb.pos.x < ctx.losX : qb.pos.x > ctx.losX;
    if (behindLine && !this.decided) {
      if (read && read.sep > 48 && read.laneRisk < 0.7) return this.fire(qb, read, throwFn);
      const trapped = pressDist < 28 || qb.pos.y < SIDELINE_MARGIN || qb.pos.y > FIELD_WIDTH - SIDELINE_MARGIN;
      if (trapped) return this.throwAway(qb, ctx, throwFn);
    }
    steerCarrier(qb, ctx);
  }
}

function nearestDefender(p: Player, ctx: PlayContext): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  for (const d of ctx.defense) {
    if (d.isDown) continue;
    const dd = dist(p.pos, d.pos);
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from point p to segment a-b. */
function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby || 1;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
