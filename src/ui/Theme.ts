/**
 * Underground / hardcore visual theme: a gritty palette, condensed display fonts,
 * and procedurally-generated grunge graphics (concrete, film grain, scanlines, a
 * distressed skull emblem). Everything is drawn to canvas — no external image assets —
 * so it stays self-contained and themable from one place.
 */

export const COLORS = {
  bg0: "#08080a", // deepest black
  bg1: "#141318", // charcoal
  panel: "#16151b", // panel fill
  concrete: "#23222a", // asphalt grey
  concreteHi: "#3a3942",
  blood: "#b3121f", // blood red (primary accent)
  bloodBright: "#e11d2b",
  bloodDeep: "#6e0b13",
  steel: "#7b8694", // cold steel
  ash: "#8b9099", // muted text
  bone: "#ece6d8", // bone white (primary text)
  hazard: "#e0b21a", // warning-tape yellow (sparing)
  rust: "#7c4a25",
  hairline: "rgba(236,230,216,0.07)",
};

/** Font stacks. Web fonts (Anton/Oswald) pop in once loaded; Impact is the fallback.
 * Screens redraw every frame, so canvas text upgrades automatically when fonts arrive. */
export const FONT = {
  display: `'Anton', 'Impact', 'Haettenschweiler', 'Arial Narrow', sans-serif`,
  ui: `'Oswald', 'Impact', 'Arial Narrow', system-ui, sans-serif`,
};

// --- Procedural grunge textures (built once, cached) ------------------------

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

let concreteTile: HTMLCanvasElement | null = null;

/** A 512² asphalt/concrete tile: grey base + grime blotches + hairline cracks. */
function getConcrete(): HTMLCanvasElement {
  if (concreteTile) return concreteTile;
  const S = 512;
  const c = makeCanvas(S, S);
  const x = c.getContext("2d")!;
  x.fillStyle = COLORS.concrete;
  x.fillRect(0, 0, S, S);
  // Speckle (per-pixel grey noise).
  const img = x.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 46;
    d[i] = clampByte(d[i] + n);
    d[i + 1] = clampByte(d[i + 1] + n);
    d[i + 2] = clampByte(d[i + 2] + n);
  }
  x.putImageData(img, 0, 0);
  // Grime blotches.
  for (let i = 0; i < 60; i++) {
    const px = Math.random() * S;
    const py = Math.random() * S;
    const pr = 30 + Math.random() * 120;
    const g = x.createRadialGradient(px, py, 0, px, py, pr);
    const dark = Math.random() < 0.5;
    g.addColorStop(0, dark ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.05)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g;
    x.fillRect(px - pr, py - pr, pr * 2, pr * 2);
  }
  // Cracks.
  x.strokeStyle = "rgba(0,0,0,0.35)";
  x.lineWidth = 1;
  for (let i = 0; i < 22; i++) {
    let cx = Math.random() * S;
    let cy = Math.random() * S;
    let a = Math.random() * Math.PI * 2;
    x.beginPath();
    x.moveTo(cx, cy);
    const segs = 3 + (Math.random() * 5) | 0;
    for (let s = 0; s < segs; s++) {
      a += (Math.random() - 0.5) * 1.3;
      cx += Math.cos(a) * (10 + Math.random() * 26);
      cy += Math.sin(a) * (10 + Math.random() * 26);
      x.lineTo(cx, cy);
    }
    x.stroke();
  }
  concreteTile = c;
  return c;
}

// Screen-sized overlay (grain + scanlines), rebuilt on resize.
let overlayCanvas: HTMLCanvasElement | null = null;
let overlayKey = "";

function getOverlay(w: number, h: number): HTMLCanvasElement {
  const key = `${w}x${h}`;
  if (overlayCanvas && overlayKey === key) return overlayCanvas;
  const c = makeCanvas(w, h);
  const x = c.getContext("2d")!;
  // Film grain.
  const img = x.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.random();
    const g = (v * 255) | 0;
    d[i] = g;
    d[i + 1] = g;
    d[i + 2] = g;
    d[i + 3] = v > 0.86 ? 16 + ((Math.random() * 26) | 0) : 0;
  }
  x.putImageData(img, 0, 0);
  // Scanlines.
  x.fillStyle = "rgba(0,0,0,0.16)";
  for (let y = 0; y < h; y += 3) x.fillRect(0, y, w, 1);
  overlayCanvas = c;
  overlayKey = key;
  return c;
}

/**
 * Paint the full gritty backdrop: charcoal gradient, concrete texture, a roaming
 * red light sweep, film-grain + scanline overlay, and a heavy vignette.
 */
export function grungeBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
): void {
  const g = ctx.createLinearGradient(0, 0, w * 0.3, h);
  g.addColorStop(0, COLORS.bg1);
  g.addColorStop(1, COLORS.bg0);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Concrete, scaled to fill.
  ctx.globalAlpha = 0.55;
  ctx.drawImage(getConcrete(), 0, 0, w, h);
  ctx.globalAlpha = 1;

  // Roaming red sweep (life + edge).
  const sx = ((t * 70) % (w + 520)) - 260;
  const sweep = ctx.createLinearGradient(sx - 180, 0, sx + 180, 0);
  sweep.addColorStop(0, "rgba(225,29,43,0)");
  sweep.addColorStop(0.5, "rgba(225,29,43,0.07)");
  sweep.addColorStop(1, "rgba(225,29,43,0)");
  ctx.fillStyle = sweep;
  ctx.fillRect(0, 0, w, h);

  // Grain + scanlines.
  ctx.drawImage(getOverlay(Math.ceil(w), Math.ceil(h)), 0, 0);

  // Vignette.
  const v = ctx.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.18, w / 2, h * 0.5, Math.max(w, h) * 0.72);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.74)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

/** A diagonal hazard-tape band (yellow/black) — used as a sparing accent strip. */
export function hazardStripe(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = COLORS.hazard;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  const step = 18;
  for (let i = -h; i < w + h; i += step * 2) {
    ctx.beginPath();
    ctx.moveTo(x + i, y);
    ctx.lineTo(x + i + step, y);
    ctx.lineTo(x + i + step - h, y + h);
    ctx.lineTo(x + i - h, y + h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
