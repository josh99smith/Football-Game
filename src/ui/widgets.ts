import type { Renderer } from "../engine/Renderer";
import type { Vec2 } from "../engine/math/Vec2";
import { COLORS, FONT } from "./Theme";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function hit(rect: Rect, p: Vec2): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

/** Returns true if any of the given tap points fell inside the rect. */
export function tappedIn(rect: Rect, taps: Vec2[]): boolean {
  return taps.some((t) => hit(rect, t));
}

/** Trace a rectangle with chamfered (cut) corners for an industrial, angular look. */
export function chamferPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: number): void {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function darken(hex: string, amt: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return hex;
  const r = Math.max(0, ((n >> 16) & 255) * (1 - amt));
  const g = Math.max(0, ((n >> 8) & 255) * (1 - amt));
  const b = Math.max(0, (n & 255) * (1 - amt));
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/**
 * A hardcore action/menu button: chamfered steel plate with a beveled metal
 * gradient, a blood-red top accent bar, rivets, and stencil-style condensed text.
 */
export function drawButton(
  r: Renderer,
  rect: Rect,
  label: string,
  opts: { fill?: string; text?: string; size?: number; sub?: string; accent?: string; flash?: number; glow?: number } = {},
): void {
  const ctx = r.ctx;
  const base = opts.fill ?? COLORS.concrete;
  const accent = opts.accent ?? COLORS.blood;
  const c = Math.min(12, rect.h * 0.28);
  const flash = Math.max(0, Math.min(1, opts.flash ?? 0));
  const glow = Math.max(0, Math.min(1, opts.glow ?? 0));

  // Attention glow: a soft accent halo behind the plate (e.g. a slow pulse on the primary CTA).
  if (glow > 0) {
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = 8 + glow * 22;
    chamferPath(ctx, rect.x, rect.y, rect.w, rect.h, c);
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.35 + glow * 0.4;
    ctx.fill();
    ctx.restore();
  }

  // Plate shadow.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  chamferPath(ctx, rect.x, rect.y, rect.w, rect.h, c);
  ctx.fillStyle = "#000";
  ctx.fill();
  ctx.restore();

  // Body fill (beveled metal).
  ctx.save();
  chamferPath(ctx, rect.x, rect.y, rect.w, rect.h, c);
  ctx.clip();
  const g = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
  g.addColorStop(0, lighten(base, 0.18));
  g.addColorStop(0.5, base);
  g.addColorStop(1, darken(base, 0.4));
  ctx.fillStyle = g;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  // Top accent bar.
  ctx.fillStyle = accent;
  ctx.fillRect(rect.x, rect.y, rect.w, Math.max(3, rect.h * 0.09));
  // Brushed sheen.
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  ctx.fillRect(rect.x, rect.y + rect.h * 0.16, rect.w, rect.h * 0.14);
  // Press flash: a bright wash that fades out after a tap for tactile feedback.
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${0.3 * flash})`;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }
  ctx.restore();

  // Edge + rivets.
  chamferPath(ctx, rect.x, rect.y, rect.w, rect.h, c);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();
  chamferPath(ctx, rect.x + 1.5, rect.y + 1.5, rect.w - 3, rect.h - 3, c - 1);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(236,230,216,0.14)";
  ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  for (const rx of [rect.x + 8, rect.x + rect.w - 8]) {
    ctx.beginPath();
    ctx.arc(rx, rect.y + rect.h - 7, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Label (condensed, uppercase, tracked out).
  ctx.save();
  ctx.letterSpacing = "1.5px";
  r.text(label.toUpperCase(), rect.x + rect.w / 2, rect.y + (opts.sub ? rect.h / 2 - 7 : rect.h / 2) + 1, {
    size: opts.size ?? 22,
    color: opts.text ?? COLORS.bone,
    align: "center",
    baseline: "middle",
    font: FONT.display,
  });
  if (opts.sub) {
    ctx.letterSpacing = "0.5px";
    r.text(opts.sub.toUpperCase(), rect.x + rect.w / 2, rect.y + rect.h / 2 + 13, {
      size: 11,
      color: "rgba(236,230,216,0.7)",
      align: "center",
      baseline: "middle",
      weight: "normal",
      font: FONT.ui,
    });
  }
  ctx.restore();
}

function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  if (Number.isNaN(n)) return hex;
  const r = Math.min(255, ((n >> 16) & 255) + amt * 255);
  const g = Math.min(255, ((n >> 8) & 255) + amt * 255);
  const b = Math.min(255, (n & 255) + amt * 255);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

/** A dark riveted panel with chamfered corners and a blood-red top edge. */
export function drawPanel(r: Renderer, rect: Rect, fill = COLORS.panel): void {
  const ctx = r.ctx;
  const c = Math.min(16, rect.h * 0.12);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  chamferPath(ctx, rect.x, rect.y, rect.w, rect.h, c);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();

  // Top accent + frame.
  ctx.save();
  chamferPath(ctx, rect.x, rect.y, rect.w, rect.h, c);
  ctx.clip();
  ctx.fillStyle = COLORS.blood;
  ctx.fillRect(rect.x, rect.y, rect.w, 4);
  ctx.restore();

  chamferPath(ctx, rect.x, rect.y, rect.w, rect.h, c);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(123,134,148,0.5)";
  ctx.stroke();
  chamferPath(ctx, rect.x + 3, rect.y + 3, rect.w - 6, rect.h - 6, c - 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(236,230,216,0.08)";
  ctx.stroke();
}
