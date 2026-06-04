import type { Renderer } from "../Renderer";

interface FloatText {
  text: string;
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  outline: string;
}

/** World-space popups like "BOOM!", "TD!", "PICKED!" that rise and fade. */
export class FloatingText {
  private readonly items: FloatText[] = [];

  add(
    text: string,
    x: number,
    y: number,
    opts: { size?: number; color?: string; life?: number; vy?: number; outline?: string } = {},
  ): void {
    const life = opts.life ?? 1.1;
    this.items.push({
      text,
      x,
      y,
      vy: opts.vy ?? -42,
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
      it.y += it.vy * dt;
      it.vy *= Math.exp(-1.5 * dt);
      if (it.life <= 0) {
        this.items[i] = this.items[this.items.length - 1];
        this.items.pop();
      }
    }
  }

  render(r: Renderer): void {
    const ctx = r.ctx;
    for (const it of this.items) {
      const t = it.life / it.maxLife;
      // Pop in then settle: scale up quickly at birth.
      const grow = t > 0.85 ? 1 + (t - 0.85) * 4 : 1;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      ctx.font = `900 ${it.size * grow}px "Trebuchet MS", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 5;
      ctx.strokeStyle = it.outline;
      ctx.strokeText(it.text, it.x, it.y);
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, it.x, it.y);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.items.length = 0;
  }
}
