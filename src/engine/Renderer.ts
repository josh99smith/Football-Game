/** Condensed industrial UI font stack (Oswald/Impact); web fonts upgrade in once loaded. */
const UI_FONT = `'Oswald', 'Impact', 'Arial Narrow', system-ui, sans-serif`;

/**
 * Owns the canvas + 2D context, handles DPR-aware resizing, and provides a small set
 * of drawing primitives. All public sizes are in CSS pixels; the device-pixel-ratio
 * scaling is applied transparently so game code never deals with raw device pixels.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  /** Logical (CSS pixel) dimensions of the drawing surface. */
  width = 0;
  height = 0;
  dpr = 1;
  /**
   * Display safe-area insets (CSS px) for notches / rounded corners / the home indicator, read from
   * `env(safe-area-inset-*)`. UI that hugs a screen edge should add the matching inset so it never
   * lands under a notch or the home bar on phones (the page sets `viewport-fit=cover`).
   */
  readonly safe = { top: 0, right: 0, bottom: 0, left: 0 };
  private safeProbe: HTMLElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // alpha:true so the 2D layer can be a transparent overlay above the WebGL field.
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;
    this.resize();
  }

  /**
   * A hidden probe whose padding is set to the four `env(safe-area-inset-*)` values; reading its
   * computed padding back gives us the insets as plain pixels (env() can't be read any other way).
   */
  private ensureSafeProbe(): HTMLElement | null {
    if (this.safeProbe || typeof document === "undefined") return this.safeProbe;
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;" +
      "padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);" +
      "padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left);";
    document.body.appendChild(el);
    this.safeProbe = el;
    return el;
  }

  private readSafeInsets(): void {
    const el = this.ensureSafeProbe();
    if (!el) return;
    const cs = getComputedStyle(el);
    this.safe.top = parseFloat(cs.paddingTop) || 0;
    this.safe.right = parseFloat(cs.paddingRight) || 0;
    this.safe.bottom = parseFloat(cs.paddingBottom) || 0;
    this.safe.left = parseFloat(cs.paddingLeft) || 0;
  }

  /** Match the backing store to the element size * DPR. Returns true if size changed. */
  resize(): boolean {
    this.readSafeInsets();
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    // Cap DPR at 2 — beyond that the fill-rate cost isn't worth it on phones.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const deviceW = Math.round(cssW * dpr);
    const deviceH = Math.round(cssH * dpr);
    if (this.canvas.width === deviceW && this.canvas.height === deviceH) return false;

    this.canvas.width = deviceW;
    this.canvas.height = deviceH;
    this.width = cssW;
    this.height = cssH;
    this.dpr = dpr;
    return true;
  }

  /** Reset the transform to identity-in-CSS-pixels and clear to a background color. */
  begin(bg: string): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /** Reset the transform and clear to full transparency (overlay above the 3D scene). */
  clear(): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
  }

  save(): void {
    this.ctx.save();
  }

  restore(): void {
    this.ctx.restore();
  }

  // --- primitives -----------------------------------------------------------

  rect(x: number, y: number, w: number, h: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  }

  strokeRect(x: number, y: number, w: number, h: number, color: string, lw = 1): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lw;
    this.ctx.strokeRect(x, y, w, h);
  }

  circle(x: number, y: number, r: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ring(x: number, y: number, r: number, color: string, lw = 2): void {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  line(x1: number, y1: number, x2: number, y2: number, color: string, lw = 1): void {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  roundRect(x: number, y: number, w: number, h: number, r: number, color: string): void {
    const { ctx } = this;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  text(
    str: string,
    x: number,
    y: number,
    opts: {
      size?: number;
      color?: string;
      align?: CanvasTextAlign;
      baseline?: CanvasTextBaseline;
      weight?: string;
      font?: string;
      alpha?: number;
    } = {},
  ): void {
    const { ctx } = this;
    const size = opts.size ?? 16;
    ctx.globalAlpha = opts.alpha ?? 1;
    ctx.fillStyle = opts.color ?? "#fff";
    ctx.textAlign = opts.align ?? "left";
    ctx.textBaseline = opts.baseline ?? "alphabetic";
    ctx.font = `${opts.weight ?? "bold"} ${size}px ${opts.font ?? UI_FONT}`;
    ctx.fillText(str, x, y);
    ctx.globalAlpha = 1;
  }

  measureText(str: string, size: number, weight = "bold"): number {
    this.ctx.font = `${weight} ${size}px ${UI_FONT}`;
    return this.ctx.measureText(str).width;
  }
}
