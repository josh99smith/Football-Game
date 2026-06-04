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
}

/**
 * World-space particle pool. Particles live on the field plane (x,y) with a height
 * (h); they are projected to the screen by the 3D camera at render time so dust
 * scatters on the turf while fire/confetti rise convincingly.
 */
export class ParticleSystem {
  private readonly pool: Particle[] = [];

  private spawn(p: Particle): void {
    this.pool.push(p);
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

  /** Continuous flame rising at a player's feet — call each frame (ON FIRE). */
  fire(x: number, y: number, count = 2): void {
    for (let i = 0; i < count; i++) {
      const life = rand(0.25, 0.5);
      this.spawn({
        x: x + rand(-6, 6), y: y + rand(-6, 6), h: rand(0, 8),
        vx: rand(-8, 8), vy: rand(-8, 8), vh: rand(80, 150),
        life, maxLife: life, size: rand(4, 9),
        color: randInt(0, 2) === 0 ? "#ffd23a" : randInt(0, 1) === 0 ? "#ff7b1e" : "#ff3b1e",
        drag: 1, gravity: -40,
      });
    }
  }

  /** A soft glowing trail mote (turbo speed lines). */
  trail(x: number, y: number, color = "#3bd2ff"): void {
    const life = rand(0.2, 0.45);
    this.spawn({
      x: x + rand(-3, 3), y: y + rand(-3, 3), h: rand(8, 22),
      vx: rand(-10, 10), vy: rand(-10, 10), vh: rand(10, 40),
      life, maxLife: life, size: rand(5, 9), color, drag: 2, gravity: -25,
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

  /** Draw all particles, projecting each to the screen. */
  render(r: Renderer, project: Projector): void {
    const ctx = r.ctx;
    for (const p of this.pool) {
      const s = project(p.x, p.y, p.h);
      if (!s.visible) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
      ctx.fillStyle = p.color;
      ctx.fillRect(s.x - p.size / 2, s.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.pool.length = 0;
  }
}
