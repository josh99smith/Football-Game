import type { Renderer } from "../engine/Renderer";
import type { Vec2 } from "../engine/math/Vec2";

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

export function drawButton(
  r: Renderer,
  rect: Rect,
  label: string,
  opts: { fill?: string; text?: string; size?: number; sub?: string } = {},
): void {
  const ctx = r.ctx;
  ctx.fillStyle = opts.fill ?? "#1c6fd0";
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 12);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();
  r.text(label, rect.x + rect.w / 2, rect.y + (opts.sub ? rect.h / 2 - 8 : rect.h / 2), {
    size: opts.size ?? 22,
    color: opts.text ?? "#fff",
    align: "center",
    baseline: "middle",
  });
  if (opts.sub) {
    r.text(opts.sub, rect.x + rect.w / 2, rect.y + rect.h / 2 + 14, {
      size: 12,
      color: "rgba(255,255,255,0.8)",
      align: "center",
      baseline: "middle",
      weight: "normal",
    });
  }
}

export function drawPanel(r: Renderer, rect: Rect, fill = "rgba(8,22,13,0.9)"): void {
  const ctx = r.ctx;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 16);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 2;
  ctx.stroke();
}
