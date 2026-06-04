import type { Renderer } from "../engine/Renderer";
import type { Camera } from "../engine/Camera";

/**
 * Field geometry and yard<->world conversions. World units are pixels.
 *
 * Layout along X (left to right):
 *   [0 .. END]            left end zone   (HOME defends, AWAY scores here)
 *   [END .. END+100yd]    field of play
 *   [END+100yd .. +END]   right end zone  (AWAY defends, HOME scores here)
 *
 * HOME always attacks +X (right), AWAY always attacks -X (left) — an arcade
 * simplification (no halftime side switch). Y runs across the field width.
 */
export const PX_PER_YARD = 16;
export const FIELD_WIDTH_YARDS = 53.3;
export const ENDZONE_YARDS = 10;
export const FIELD_PLAY_YARDS = 100;

export const FIELD_WIDTH = FIELD_WIDTH_YARDS * PX_PER_YARD; // across (Y)
export const ENDZONE_PX = ENDZONE_YARDS * PX_PER_YARD;
export const FIELD_LENGTH = (FIELD_PLAY_YARDS + ENDZONE_YARDS * 2) * PX_PER_YARD; // along (X)

/** X of the left goal line (boundary between left end zone and field of play). */
export const LEFT_GOAL_X = ENDZONE_PX;
/** X of the right goal line. */
export const RIGHT_GOAL_X = ENDZONE_PX + FIELD_PLAY_YARDS * PX_PER_YARD;

export const SIDELINE_MARGIN = 0; // play to the chalk

export function yards(n: number): number {
  return n * PX_PER_YARD;
}

/** World X for a given yardage from the LEFT goal line (0..100). */
export function xFromLeftGoal(yardsFromLeft: number): number {
  return LEFT_GOAL_X + yardsFromLeft * PX_PER_YARD;
}

/** Convert a world X to the football "yard line" label (0 at each goal, 50 mid). */
export function yardLineLabel(x: number): number {
  const fromLeft = (x - LEFT_GOAL_X) / PX_PER_YARD;
  const clamped = Math.max(0, Math.min(100, fromLeft));
  return Math.round(clamped <= 50 ? clamped : 100 - clamped);
}

export class Field {
  /** Total world bounds (including end zones). */
  readonly minX = 0;
  readonly maxX = FIELD_LENGTH;
  readonly minY = 0;
  readonly maxY = FIELD_WIDTH;

  /** Whether x is within (or beyond) a team's target end zone. */
  inRightEndzone(x: number): boolean {
    return x >= RIGHT_GOAL_X;
  }

  inLeftEndzone(x: number): boolean {
    return x <= LEFT_GOAL_X;
  }

  clampY(y: number): number {
    return Math.max(this.minY + 2, Math.min(this.maxY - 2, y));
  }

  /** Draw the field (turf, end zones, yard lines, hash marks, numbers) in world space. */
  render(r: Renderer, cam: Camera): void {
    const ctx = r.ctx;

    // Turf base, then alternating 5-yard mow stripes for depth.
    r.rect(LEFT_GOAL_X, this.minY, RIGHT_GOAL_X - LEFT_GOAL_X, FIELD_WIDTH, "#178a3c");
    for (let yd = 0; yd < FIELD_PLAY_YARDS; yd += 5) {
      if ((yd / 5) % 2 === 0) {
        r.rect(xFromLeftGoal(yd), this.minY, yards(5), FIELD_WIDTH, "#149036");
      }
    }

    // End zones.
    r.rect(this.minX, this.minY, ENDZONE_PX, FIELD_WIDTH, "#0e6b8f");
    r.rect(RIGHT_GOAL_X, this.minY, ENDZONE_PX, FIELD_WIDTH, "#b03a3a");

    // Yard lines every 5 yards + goal lines.
    for (let yd = 0; yd <= FIELD_PLAY_YARDS; yd += 5) {
      const x = xFromLeftGoal(yd);
      const isGoal = yd === 0 || yd === FIELD_PLAY_YARDS;
      r.line(x, this.minY, x, this.maxY, isGoal ? "#ffffff" : "rgba(255,255,255,0.85)", isGoal ? 4 : 2);
    }

    // Hash marks every yard along the two inbound hash rows.
    const hashTop = FIELD_WIDTH * 0.36;
    const hashBot = FIELD_WIDTH * 0.64;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1.5;
    for (let yd = 1; yd < FIELD_PLAY_YARDS; yd++) {
      if (yd % 5 === 0) continue;
      const x = xFromLeftGoal(yd);
      ctx.beginPath();
      ctx.moveTo(x, hashTop - 4);
      ctx.lineTo(x, hashTop + 4);
      ctx.moveTo(x, hashBot - 4);
      ctx.lineTo(x, hashBot + 4);
      ctx.stroke();
    }

    // Yard numbers (10,20,...,50,...,20,10) near each sideline.
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textAlign = "center";
    for (let yd = 10; yd < FIELD_PLAY_YARDS; yd += 10) {
      const label = String(yd <= 50 ? yd : 100 - yd);
      const x = xFromLeftGoal(yd);
      ctx.save();
      ctx.font = `900 22px "Trebuchet MS", system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(label, x, this.minY + 12);
      ctx.textBaseline = "bottom";
      ctx.fillText(label, x, this.maxY - 12);
      ctx.restore();
    }

    // Sideline borders.
    r.line(this.minX, this.minY, this.maxX, this.minY, "#ffffff", 3);
    r.line(this.minX, this.maxY, this.maxX, this.maxY, "#ffffff", 3);
    void cam;
  }
}
