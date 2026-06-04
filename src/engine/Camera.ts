import { clamp, lerp, type Vec2 } from "./math/Vec2";

/**
 * Maps world coordinates (field space, in world pixels) to screen coordinates.
 * The camera centers on a focus point, applies a zoom, and adds a transient shake
 * offset for "juice". Game code draws in world space between `apply()`/`reset()`.
 */
export class Camera {
  /** World-space point the camera is centered on. */
  cx = 0;
  cy = 0;
  zoom = 1;

  shakeX = 0;
  shakeY = 0;

  private screenW = 0;
  private screenH = 0;

  setViewport(w: number, h: number): void {
    this.screenW = w;
    this.screenH = h;
  }

  /** Smoothly move the focus toward a target (exponential smoothing). */
  follow(target: Vec2, smoothing: number, dt: number): void {
    const t = 1 - Math.pow(1 - smoothing, dt * 60);
    this.cx = lerp(this.cx, target.x, t);
    this.cy = lerp(this.cy, target.y, t);
  }

  snapTo(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
  }

  /** Clamp the focus so the view never shows beyond the given world bounds. */
  clampToBounds(minX: number, minY: number, maxX: number, maxY: number): void {
    const halfW = this.screenW / 2 / this.zoom;
    const halfH = this.screenH / 2 / this.zoom;
    // If the world is smaller than the view on an axis, center it.
    if (maxX - minX < halfW * 2) {
      this.cx = (minX + maxX) / 2;
    } else {
      this.cx = clamp(this.cx, minX + halfW, maxX - halfW);
    }
    if (maxY - minY < halfH * 2) {
      this.cy = (minY + maxY) / 2;
    } else {
      this.cy = clamp(this.cy, minY + halfH, maxY - halfH);
    }
  }

  worldToScreenX(wx: number): number {
    return (wx - this.cx) * this.zoom + this.screenW / 2 + this.shakeX;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.cy) * this.zoom + this.screenH / 2 + this.shakeY;
  }

  screenToWorldX(sx: number): number {
    return (sx - this.screenW / 2 - this.shakeX) / this.zoom + this.cx;
  }

  screenToWorldY(sy: number): number {
    return (sy - this.screenH / 2 - this.shakeY) / this.zoom + this.cy;
  }

  /** Apply the camera transform to a context so subsequent draws are in world space. */
  apply(ctx: CanvasRenderingContext2D, dpr: number): void {
    ctx.save();
    // Compose: device-pixel scale -> translate to screen center+shake -> zoom -> -focus
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(this.screenW / 2 + this.shakeX, this.screenH / 2 + this.shakeY);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.cx, -this.cy);
  }

  reset(ctx: CanvasRenderingContext2D): void {
    ctx.restore();
  }
}
