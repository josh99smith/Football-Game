import type { Renderer } from "../Renderer";
import type { Projector } from "./ParticleSystem";

interface FloatText {
  text: string;
  x: number; // field-plane world position
  y: number;
  h: number; // current height (px), rises over life
  riseSpeed: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  outline: string;
}

/** Most popups allowed on screen at once — beyond this the oldest is retired so call-outs from a
 *  busy sequence (hit + break + tackle + commentary) can't pile into an unreadable stack. */
const MAX_ITEMS = 3;

/** World-anchored popups like "BOOM!", "TD!", "PICKED!" that rise and fade. */
export class FloatingText {
  private readonly items: FloatText[] = [];

  add(
    text: string,
    x: number,
    y: number,
    opts: { size?: number; color?: string; life?: number; outline?: string } = {},
  ): void {
    // Drop an identical popup that's still fresh on screen (avoids the same word doubling up).
    if (this.items.some((it) => it.text === text && it.life > it.maxLife * 0.5)) return;
    // Cap concurrent popups: retire the oldest so the screen never crowds.
    while (this.items.length >= MAX_ITEMS) this.items.shift();
    const life = opts.life ?? 1.1;
    this.items.push({
      text,
      x,
      y,
      h: 28,
      riseSpeed: 70,
      life,
      maxLife: life,
      size: opts.size ?? 26,
      color: opts.color ?? "#ffffff",
      outline: opts.outline ?? "#111111",
    });
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life -= dt;
      it.h += it.riseSpeed * dt;
      it.riseSpeed *= Math.exp(-1.5 * dt);
      if (it.life <= 0) {
        this.items[i] = this.items[this.items.length - 1];
        this.items.pop();
      }
    }
  }

  render(r: Renderer, project: Projector): void {
    const ctx = r.ctx;
    for (const it of this.items) {
      const s = project(it.x, it.y, it.h);
      if (!s.visible) continue;
      const t = it.life / it.maxLife;
      // Pop in then settle.
      const grow = t > 0.85 ? 1 + (t - 0.85) * 4 : 1;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.font = `900 ${it.size * grow}px "Trebuchet MS", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 5;
      ctx.strokeStyle = it.outline;
      ctx.strokeText(it.text, s.x, s.y);
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, s.x, s.y);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.items.length = 0;
  }
}
