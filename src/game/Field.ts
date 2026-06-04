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

  /**
   * Draw the full field markings into a 2D context in field-pixel space (0..FIELD_LENGTH
   * by 0..FIELD_WIDTH). Used to bake a richly-textured turf for the 3D field plane.
   * Optional team colors paint the end zones.
   */
  drawTexture(ctx: CanvasRenderingContext2D, homeColor = "#0e6b8f", awayColor = "#b03a3a"): void {
    // Base turf.
    ctx.fillStyle = "#16823a";
    ctx.fillRect(0, 0, FIELD_LENGTH, FIELD_WIDTH);

    // Mowing stripes: alternating brightness every 5 yards across the field.
    for (let yd = 0; yd < FIELD_PLAY_YARDS; yd += 5) {
      ctx.fillStyle = (yd / 5) % 2 === 0 ? "#1b9442" : "#138537";
      ctx.fillRect(xFromLeftGoal(yd), 0, yards(5), FIELD_WIDTH);
    }
    // Cross-mow: subtle horizontal bands for a checker effect.
    ctx.globalAlpha = 0.06;
    for (let i = 0; i < 8; i++) {
      if (i % 2 === 0) {
        ctx.fillStyle = "#000000";
        ctx.fillRect(LEFT_GOAL_X, (FIELD_WIDTH / 8) * i, RIGHT_GOAL_X - LEFT_GOAL_X, FIELD_WIDTH / 8);
      }
    }
    ctx.globalAlpha = 1;

    // Grass speckle for texture (cheap one-time bake).
    for (let i = 0; i < 9000; i++) {
      const gx = LEFT_GOAL_X + Math.random() * (RIGHT_GOAL_X - LEFT_GOAL_X);
      const gy = Math.random() * FIELD_WIDTH;
      ctx.fillStyle = Math.random() > 0.5 ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)";
      ctx.fillRect(gx, gy, 2, 2);
    }

    // End zones (team-colored) with a diagonal hatch.
    this.endzone(ctx, 0, homeColor);
    this.endzone(ctx, RIGHT_GOAL_X, awayColor);

    // Yard lines + goal lines.
    for (let yd = 0; yd <= FIELD_PLAY_YARDS; yd += 5) {
      const x = xFromLeftGoal(yd);
      const isGoal = yd === 0 || yd === FIELD_PLAY_YARDS;
      ctx.strokeStyle = isGoal ? "#ffffff" : "rgba(255,255,255,0.88)";
      ctx.lineWidth = isGoal ? 7 : 3;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, FIELD_WIDTH);
      ctx.stroke();
    }

    // Hash marks (two inbound rows) every yard.
    const hashTop = FIELD_WIDTH * 0.36;
    const hashBot = FIELD_WIDTH * 0.64;
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 2;
    for (let yd = 1; yd < FIELD_PLAY_YARDS; yd++) {
      if (yd % 5 === 0) continue;
      const x = xFromLeftGoal(yd);
      for (const hy of [hashTop, hashBot, FIELD_WIDTH * 0.04, FIELD_WIDTH * 0.96]) {
        ctx.beginPath();
        ctx.moveTo(x, hy - 5);
        ctx.lineTo(x, hy + 5);
        ctx.stroke();
      }
    }

    // Yard numbers with direction arrows near each sideline.
    for (let yd = 10; yd < FIELD_PLAY_YARDS; yd += 10) {
      const n = yd <= 50 ? yd : 100 - yd;
      const x = xFromLeftGoal(yd);
      this.yardNumber(ctx, x, FIELD_WIDTH * 0.13, n, yd);
      this.yardNumber(ctx, x, FIELD_WIDTH * 0.87, n, yd);
    }

    // Midfield logo: a ringed star at the 50.
    this.midfieldLogo(ctx, xFromLeftGoal(50), FIELD_WIDTH / 2);

    // Sideline border.
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 6;
    ctx.strokeRect(2, 2, FIELD_LENGTH - 4, FIELD_WIDTH - 4);
  }

  private endzone(ctx: CanvasRenderingContext2D, x0: number, color: string): void {
    ctx.fillStyle = color;
    ctx.fillRect(x0, 0, ENDZONE_PX, FIELD_WIDTH);
    // Diagonal hatch.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, ENDZONE_PX, FIELD_WIDTH);
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 6;
    for (let d = -FIELD_WIDTH; d < ENDZONE_PX; d += 26) {
      ctx.beginPath();
      ctx.moveTo(x0 + d, 0);
      ctx.lineTo(x0 + d + FIELD_WIDTH, FIELD_WIDTH);
      ctx.stroke();
    }
    ctx.restore();
    // "BLITZ" wordmark.
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.font = `900 70px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.translate(x0 + ENDZONE_PX / 2, FIELD_WIDTH / 2);
    ctx.rotate(x0 === 0 ? -Math.PI / 2 : Math.PI / 2);
    ctx.fillText("BLITZ", 0, 0);
    ctx.restore();
  }

  private yardNumber(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, yd: number): void {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = `900 34px "Trebuchet MS", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const s = String(n);
    ctx.fillText(s[0], x - 14, y);
    if (s[1]) ctx.fillText(s[1], x + 14, y);
    // Direction arrow toward the nearer goal line (real-field convention).
    if (n < 50) {
      const dir = yd < 50 ? -1 : 1;
      const ax = x + dir * 40;
      ctx.beginPath();
      ctx.moveTo(ax + dir * 8, y);
      ctx.lineTo(ax, y - 7);
      ctx.lineTo(ax, y + 7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private midfieldLogo(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(0, 0, 70, 0, Math.PI * 2);
    ctx.stroke();
    // Star.
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const ang = (Math.PI / 5) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? 52 : 22;
      const px = Math.cos(ang) * rad;
      const py = Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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
