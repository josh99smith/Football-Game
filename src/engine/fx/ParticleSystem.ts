import type { Renderer } from "../Renderer";
import { rand, randInt } from "../math/random";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  drag: number;
  gravity: number;
}

/** Simple world-space particle pool for dust, sparks, and fire. */
export class ParticleSystem {
  private readonly pool: Particle[] = [];

  private spawn(p: Particle): void {
    this.pool.push(p);
  }

  /** A puff of dust on tackles / cuts. */
  burst(x: number, y: number, color: string, count = 10, speed = 120): void {
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const s = rand(speed * 0.3, speed);
      const life = rand(0.3, 0.7);
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life,
        maxLife: life,
        size: rand(2, 5),
        color,
        drag: 3,
        gravity: 0,
      });
    }
  }

  /** Sparks that shoot in a rough direction (big hits). */
  spark(x: number, y: number, dirX: number, dirY: number, count = 14): void {
    const base = Math.atan2(dirY, dirX);
    for (let i = 0; i < count; i++) {
      const a = base + rand(-0.9, 0.9);
      const s = rand(140, 320);
      const life = rand(0.2, 0.5);
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life,
        maxLife: life,
        size: rand(2, 4),
        color: rand(0, 1) > 0.5 ? "#ffe24a" : "#ff8a1e",
        drag: 2,
        gravity: 0,
      });
    }
  }

  /** Continuous flame for the "ON FIRE" state — call each frame at a player's feet. */
  fire(x: number, y: number, count = 2): void {
    for (let i = 0; i < count; i++) {
      const life = rand(0.25, 0.5);
      this.spawn({
        x: x + rand(-6, 6),
        y: y + rand(-4, 4),
        vx: rand(-12, 12),
        vy: rand(-70, -110),
        life,
        maxLife: life,
        size: rand(3, 7),
        color: randInt(0, 2) === 0 ? "#ffd23a" : randInt(0, 1) === 0 ? "#ff7b1e" : "#ff3b1e",
        drag: 1,
        gravity: 0,
      });
    }
  }

  /** Confetti-ish celebration burst for touchdowns. */
  confetti(x: number, y: number, count = 40): void {
    const colors = ["#ffd23a", "#ff5a5a", "#5ad1ff", "#7bff8a", "#ff8af0"];
    for (let i = 0; i < count; i++) {
      const a = rand(-Math.PI, 0);
      const s = rand(120, 340);
      const life = rand(0.7, 1.4);
      this.spawn({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life,
        maxLife: life,
        size: rand(3, 6),
        color: colors[randInt(0, colors.length - 1)],
        drag: 0.6,
        gravity: 380,
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
      p.vy = p.vy * d + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  /** Draw in world space (call between camera apply/reset). */
  render(r: Renderer): void {
    const ctx = r.ctx;
    for (const p of this.pool) {
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.pool.length = 0;
  }
}
