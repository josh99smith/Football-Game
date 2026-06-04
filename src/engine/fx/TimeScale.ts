/**
 * Controls simulation time scaling for "hit-stop" (a brief freeze) and slow-motion
 * on big hits / touchdowns. Game code multiplies its dt by `value` each frame.
 */
export class TimeScale {
  value = 1;

  private freezeTimer = 0;
  private slowTimer = 0;
  private slowAmount = 1;

  /** Hard freeze for `seconds`, then resume normal time. */
  freeze(seconds: number): void {
    this.freezeTimer = Math.max(this.freezeTimer, seconds);
  }

  /** Slow time to `scale` (e.g. 0.35) for `seconds`, easing back to 1. */
  slow(scale: number, seconds: number): void {
    this.slowAmount = scale;
    this.slowTimer = Math.max(this.slowTimer, seconds);
  }

  /** Punchy combo used for big tackles: a tiny freeze then a short slow-mo. */
  bigHit(): void {
    this.freeze(0.06);
    this.slow(0.4, 0.22);
  }

  /** Advance using REAL (unscaled) dt; returns the time scale to apply this frame. */
  update(realDt: number): number {
    if (this.freezeTimer > 0) {
      this.freezeTimer -= realDt;
      this.value = 0;
      return 0;
    }
    if (this.slowTimer > 0) {
      this.slowTimer -= realDt;
      // Ease back toward 1 as the slow window elapses.
      this.value = this.slowAmount;
    } else {
      this.value = 1;
    }
    return this.value;
  }
}
