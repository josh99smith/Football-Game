import { rand } from "../math/random";

/**
 * Trauma-based screen shake. Callers add "trauma" (0..1) on impacts; the actual
 * offset scales with trauma squared for a punchy feel and decays over time.
 */
export class ScreenShake {
  private trauma = 0;
  offsetX = 0;
  offsetY = 0;

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt: number, maxOffset = 18): void {
    if (this.trauma <= 0) {
      this.offsetX = 0;
      this.offsetY = 0;
      return;
    }
    const shake = this.trauma * this.trauma;
    this.offsetX = rand(-1, 1) * maxOffset * shake;
    this.offsetY = rand(-1, 1) * maxOffset * shake;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
  }
}
