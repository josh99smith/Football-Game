import { rand } from "../math/random";

/**
 * Trauma-based screen shake. Callers add "trauma" (0..1) on impacts; the actual
 * offset scales with trauma squared for a punchy feel and decays over time.
 */
export class ScreenShake {
  private trauma = 0;
  // Directional impulse: a one-shot lurch along the hit vector (px) that decays fast. Layered on
  // top of the random trauma jitter so a tackle visibly *shoves* the camera the way the runner is
  // driven, instead of just rattling it.
  private kickX = 0;
  private kickY = 0;
  offsetX = 0;
  offsetY = 0;

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** A directional camera lurch (px) along (dx,dy); the vector is normalized, magnitude is `amount`. */
  kick(dx: number, dy: number, amount: number): void {
    const l = Math.hypot(dx, dy) || 1;
    this.kickX += (dx / l) * amount;
    this.kickY += (dy / l) * amount;
  }

  update(dt: number, maxOffset = 18): void {
    let ox = this.kickX;
    let oy = this.kickY;
    if (this.trauma > 0) {
      const shake = this.trauma * this.trauma;
      ox += rand(-1, 1) * maxOffset * shake;
      oy += rand(-1, 1) * maxOffset * shake;
      this.trauma = Math.max(0, this.trauma - dt * 1.6);
    }
    this.offsetX = ox;
    this.offsetY = oy;
    // Snappy spring-ish decay so the lurch punches out and recovers in ~0.18s.
    const k = Math.max(0, 1 - dt * 11);
    this.kickX *= k;
    this.kickY *= k;
    if (Math.abs(this.kickX) < 0.05) this.kickX = 0;
    if (Math.abs(this.kickY) < 0.05) this.kickY = 0;
  }
}
