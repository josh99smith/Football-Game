import type { Renderer } from "../Renderer";
import { rand, randInt } from "../math/random";

/** Projects a field-world point (+ pixel height) to overlay screen coordinates. */
export type Projector = (x: number, y: number, h: number) => { x: number; y: number; visible: boolean };

interface Particle {
  x: number; // field-plane X (world px)
  y: number; // field-plane Y (world px)
  h: number; // height above the field (world px)
  vx: number;
  vy: number;
  vh: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  drag: number;
  gravity: number; // pulls height down
  /** Soft additive glow sprite (flames/embers) vs a hard square (dust/confetti). */
  glow?: boolean;
  /** Size multiplier reached at end of life: <1 tapers (flames narrow), >1 grows (smoke). */
  shrink?: number;
  /** Fade with a soft in/out bell instead of linear (smoke / soft glows). */
  soft?: boolean;
}

/**
 * World-space particle pool. Particles live on the field plane (x,y) with a height
 * (h); they are projected to the screen by the 3D camera at render time so dust
 * scatters on the turf while fire/confetti rise convincingly.
 */
/** Hard cap on live particles so a long on-fire stretch can't grow the pool unbounded on phones. */
const MAX_PARTICLES = 500;

export class ParticleSystem {
  private readonly pool: Particle[] = [];
  /** Cache of soft radial glow sprites keyed by color (additive flame/ember rendering). */
  private readonly glowCache = new Map<string, HTMLCanvasElement>();

  private spawn(p: Particle): void {
    // At the cap, retire the oldest particle to make room — bounds the per-frame work on low-end GPUs.
    if (this.pool.length >= MAX_PARTICLES) this.pool.shift();
    this.pool.push(p);
  }

  /** A soft round glow sprite (bright core fading to transparent) for additive flames/embers. */
  private glowSprite(color: string): HTMLCanvasElement {
    let c = this.glowCache.get(color);
    if (c) return c;
    const S = 48;
    c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.4, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    // Fade the mid/outer to transparent by drawing the color then a transparent edge.
    g.fillStyle = grad;
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    g.fill();
    this.glowCache.set(color, c);
    return c;
  }

  /** A puff of dust on tackles / cuts (scatters along the ground). */
  burst(x: number, y: number, color: string, count = 10, speed = 120): void {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(speed * 0.3, speed);
      const life = rand(0.3, 0.7);
      this.spawn({
        x, y, h: rand(2, 10),
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, vh: rand(20, 80),
        life, maxLife: life, size: rand(3, 6), color, drag: 3, gravity: 220,
      });
    }
  }

  /** Sparks that shoot in a rough ground direction with some lift (big hits). */
  spark(x: number, y: number, dirX: number, dirY: number, count = 14): void {
    const base = Math.atan2(dirY, dirX);
    for (let i = 0; i < count; i++) {
      const a = base + rand(-0.9, 0.9);
      const s = rand(140, 320);
      const life = rand(0.2, 0.5);
      this.spawn({
        x, y, h: rand(8, 24),
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, vh: rand(120, 260),
        life, maxLife: life, size: rand(3, 5),
        color: rand(0, 1) > 0.5 ? "#ffe24a" : "#ff8a1e", drag: 2, gravity: 600,
      });
    }
  }

  /**
   * A licking flame column rising off a player — call each frame (ON FIRE). Layers a
   * white-hot core, orange/red flame tongues that taper as they rise, and the odd curl of
   * dark smoke, all flickering, for a believable fire rather than a spray of dots.
   * `scale` (0..1+) drives how broad/tall the fire is.
   */
  fire(x: number, y: number, count = 2, scale = 1): void {
    for (let i = 0; i < count; i++) {
      const r = Math.random();
      if (r < 0.16) {
        // Smoke: dark, slow, grows and softly fades as it drifts up off the top of the flame.
        const life = rand(0.5, 0.95);
        this.spawn({
          x: x + rand(-6, 6) * scale, y: y + rand(-6, 6) * scale, h: rand(16, 28) * scale,
          vx: rand(-7, 7), vy: rand(-7, 7), vh: rand(36, 64),
          life, maxLife: life, size: rand(8, 12) * scale, color: "#5a5048",
          drag: 1.2, gravity: -10, shrink: 2.6, soft: true,
        });
      } else {
        // Flame tongue: hot white/yellow core or an orange/red body; rises and tapers.
        const hot = r < 0.52;
        const life = rand(0.24, 0.46);
        this.spawn({
          x: x + rand(-5, 5) * scale, y: y + rand(-3, 3) * scale, h: rand(0, 6),
          vx: rand(-8, 8), vy: rand(-8, 8), vh: rand(110, 170) * (0.7 + 0.4 * scale),
          life, maxLife: life,
          size: (hot ? rand(4, 7) : rand(7, 11)) * scale,
          color: hot
            ? (Math.random() < 0.5 ? "#ffe9a8" : "#ffc41e")
            : (Math.random() < 0.5 ? "#ff7b1e" : "#ff4513"),
          drag: 1.5, gravity: -45, glow: true, shrink: 0.34,
        });
      }
    }
  }

  /** A hot ember/flame trail streaming off a sprinting player (TURBO). */
  trail(x: number, y: number): void {
    const hot = Math.random() < 0.4;
    const life = rand(0.2, 0.4);
    this.spawn({
      x: x + rand(-3, 3), y: y + rand(-3, 3), h: rand(5, 16),
      vx: rand(-10, 10), vy: rand(-10, 10), vh: rand(35, 80),
      life, maxLife: life,
      size: hot ? rand(2, 4) : rand(4, 6),
      color: hot ? "#ffe9a8" : (Math.random() < 0.5 ? "#ff9b2e" : "#ff5a1e"),
      drag: 2.2, gravity: -30, glow: true, shrink: 0.3,
    });
  }

  /** Celebration burst for touchdowns (up then fall). */
  confetti(x: number, y: number, count = 40): void {
    const colors = ["#ffd23a", "#ff5a5a", "#5ad1ff", "#7bff8a", "#ff8af0"];
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(40, 140);
      const life = rand(0.8, 1.6);
      this.spawn({
        x, y, h: rand(20, 60),
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, vh: rand(260, 460),
        life, maxLife: life, size: rand(4, 7),
        color: colors[randInt(0, colors.length - 1)], drag: 0.6, gravity: 520,
      });
    }
  }

  update(dt: number): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.pool[i] = this.pool[this.pool.length - 1];
        this.pool.pop();
        continue;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.vh = p.vh * d - p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.h += p.vh * dt;
      if (p.h < 0) {
        p.h = 0;
        p.vh = 0;
      }
    }
  }

  /** Draw all particles, projecting each to the screen. Solid bits (dust/confetti) draw with
   *  normal blending; glow particles (flames/embers) draw additively on top as soft sprites. */
  render(r: Renderer, project: Projector): void {
    const ctx = r.ctx;
    // Pass 1: solid particles with normal alpha blending. Soft ones (smoke) draw as round
    // puffs; hard ones (dust, confetti) stay as little squares.
    for (const p of this.pool) {
      if (p.glow) continue;
      const s = project(p.x, p.y, p.h);
      if (!s.visible) continue;
      const t = p.life / p.maxLife;
      const sz = p.size * (p.shrink != null ? p.shrink + (1 - p.shrink) * t : 1);
      ctx.fillStyle = p.color;
      if (p.soft) {
        ctx.globalAlpha = Math.sin(Math.PI * (1 - t)) * 0.4; // gentle haze, fades in and out
        ctx.beginPath();
        ctx.arc(s.x, s.y, sz, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = Math.max(0, Math.min(1, t));
        ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
      }
    }
    // Pass 2: additive glow (flames / embers) layered on top so overlaps brighten to white-hot.
    ctx.globalCompositeOperation = "lighter";
    for (const p of this.pool) {
      if (!p.glow) continue;
      const s = project(p.x, p.y, p.h);
      if (!s.visible) continue;
      const t = p.life / p.maxLife;
      const sz = p.size * (p.shrink != null ? p.shrink + (1 - p.shrink) * t : 1);
      // Slightly under 1 so stacked additive glows don't blow out to a solid white blob.
      ctx.globalAlpha = (p.soft ? Math.sin(Math.PI * (1 - t)) : Math.max(0, Math.min(1, t))) * 0.7;
      const spr = this.glowSprite(p.color);
      ctx.drawImage(spr, s.x - sz, s.y - sz, sz * 2, sz * 2);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.pool.length = 0;
  }
}
