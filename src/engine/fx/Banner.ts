import type { Renderer } from "../Renderer";

interface BannerItem {
  text: string;
  sub: string;
  color: string;
  accent: string;
  life: number;
  maxLife: number;
}

/**
 * Big screen-space announcer call-outs for marquee moments ("TOUCHDOWN!", "SACK!", "ON FIRE!").
 * One at a time — a new call replaces the old — slamming in scaled-up, holding, then sliding up and
 * fading. Drawn on the 2D overlay above everything (separate from the world-anchored FloatingText).
 */
export class Banner {
  private item: BannerItem | null = null;

  show(text: string, opts: { sub?: string; color?: string; accent?: string; life?: number } = {}): void {
    const life = opts.life ?? 2.0;
    this.item = {
      text,
      sub: opts.sub ?? "",
      color: opts.color ?? "#ffffff",
      accent: opts.accent ?? "#ffd23a",
      life,
      maxLife: life,
    };
  }

  update(dt: number): void {
    if (!this.item) return;
    this.item.life -= dt;
    if (this.item.life <= 0) this.item = null;
  }

  render(r: Renderer): void {
    const it = this.item;
    if (!it) return;
    const ctx = r.ctx;
    const W = r.width;
    const t = it.life / it.maxLife; // 1 -> 0
    const age = 1 - t;
    // Slam in (first ~16%), hold, then float up + fade (last ~30%).
    const inK = Math.min(1, age / 0.16);
    const outK = t < 0.3 ? t / 0.3 : 1;
    const scale = 1 + (1 - inK) * 0.6; // overshoot in
    const alpha = Math.min(inK * 1.4, outK);
    const cx = W / 2;
    const cy = r.height * 0.28 - (1 - outK) * 36; // drifts upward as it leaves

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.min(W * 0.11, 64) * scale;

    // Accent slab behind the headline so it reads on a busy field.
    ctx.font = `900 ${size}px Anton, "Trebuchet MS", system-ui, sans-serif`;
    const w = ctx.measureText(it.text).width;
    ctx.globalAlpha = alpha * 0.5;
    ctx.fillStyle = "rgba(8,8,12,0.78)";
    const padX = size * 0.45;
    const slabH = size * 1.28;
    ctx.fillRect(cx - w / 2 - padX, cy - slabH / 2, w + padX * 2, slabH);
    // Accent rule lines top & bottom.
    ctx.fillStyle = it.accent;
    ctx.fillRect(cx - w / 2 - padX, cy - slabH / 2, w + padX * 2, Math.max(2, size * 0.05));
    ctx.fillRect(cx - w / 2 - padX, cy + slabH / 2 - Math.max(2, size * 0.05), w + padX * 2, Math.max(2, size * 0.05));

    // Headline.
    ctx.globalAlpha = alpha;
    ctx.lineWidth = Math.max(4, size * 0.08);
    ctx.strokeStyle = "#0a0a0e";
    ctx.strokeText(it.text, cx, cy);
    ctx.fillStyle = it.color;
    ctx.fillText(it.text, cx, cy);

    // Sub-line.
    if (it.sub) {
      const ss = size * 0.34;
      ctx.font = `700 ${ss}px Oswald, "Trebuchet MS", system-ui, sans-serif`;
      ctx.lineWidth = Math.max(3, ss * 0.12);
      ctx.strokeStyle = "#0a0a0e";
      const sy = cy + slabH / 2 + ss * 0.9;
      ctx.strokeText(it.sub, cx, sy);
      ctx.fillStyle = it.accent;
      ctx.fillText(it.sub, cx, sy);
    }
    ctx.restore();
  }

  clear(): void {
    this.item = null;
  }
}
