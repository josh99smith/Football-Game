import type { Player } from "../entities/Player";
import type { PlayContext } from "./DefenseAI";
import { addSteer } from "./Steering";
import { type Vec2 } from "../../engine/math/Vec2";
import { FIELD_WIDTH } from "../Field";
import { QuarterbackAI } from "./QuarterbackAI";

const SIDELINE_MARGIN = 70; // px from a sideline where carriers get pushed back infield

/**
 * Drives the CPU when it has possession: the quarterback (delegated to the QuarterbackAI brain)
 * and the ball carrier's open-field running. The throw itself is performed via the `throwFn`
 * callback so the owning state controls ball state + sounds.
 */
export class CPUOffense {
  private readonly qb: QuarterbackAI;

  constructor(difficulty: "rookie" | "pro" | "allpro") {
    this.qb = new QuarterbackAI(difficulty);
  }

  reset(): void {
    this.qb.reset();
  }

  update(
    ctx: PlayContext,
    throwFn: (from: Player, target: Vec2, receiver: Player | null, power?: number) => void,
  ): void {
    const carrier = ctx.carrier;
    if (!carrier) return;
    if (carrier.role === "QB" && !this.qb.released) {
      this.qb.update(ctx, throwFn); // drop / read / throw / scramble
    } else {
      steerCarrier(carrier, ctx); // a runner (or the QB after he's tucked it) heads for daylight
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
  // Keep strong forward intent even while evading, so a scramble presses upfield for yards
  // rather than drifting laterally toward the boundary.
  steer.x += ctx.dir * 0.9;
  carrier.desired = steer;
  keepInbounds(carrier);
  // Turbo for daylight — but only when a defender actually exists/closes. `near` starts at Infinity,
  // so with no upright defenders this used to force turbo permanently on (draining it on a player the
  // human may take over next frame, e.g. the auto-steered superstar receiver).
  carrier.turbo = near !== Infinity && near > 34;
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
