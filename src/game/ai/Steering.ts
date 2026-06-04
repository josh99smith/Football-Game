import { type Vec2 } from "../../engine/math/Vec2";
import type { Player } from "../entities/Player";

/** Steering helpers that return a desired direction (unit-ish) for a player. */

export function seek(from: Vec2, target: Vec2): Vec2 {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}

export function flee(from: Vec2, threat: Vec2): Vec2 {
  const s = seek(from, threat);
  return { x: -s.x, y: -s.y };
}

/** Lead a moving target by predicting where it will be. */
export function pursue(from: Vec2, target: Player, predictScale = 0.18): Vec2 {
  const predicted = {
    x: target.pos.x + target.vel.x * predictScale,
    y: target.pos.y + target.vel.y * predictScale,
  };
  return seek(from, predicted);
}

/** Push apart from nearby same-purpose teammates to avoid clumping. */
export function separation(self: Player, others: Player[], radius: number): Vec2 {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const o of others) {
    if (o === self || o.isDown) continue;
    const dx = self.pos.x - o.pos.x;
    const dy = self.pos.y - o.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > 0 && d < radius) {
      sx += (dx / d) * (1 - d / radius);
      sy += (dy / d) * (1 - d / radius);
      n++;
    }
  }
  if (n === 0) return { x: 0, y: 0 };
  return { x: sx, y: sy };
}

export function addSteer(a: Vec2, b: Vec2, weight = 1): Vec2 {
  return { x: a.x + b.x * weight, y: a.y + b.y * weight };
}
