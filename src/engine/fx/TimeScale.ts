/**
 * Controls simulation time scaling for "hit-stop" (a brief freeze) and slow-motion
 * on big hits / touchdowns. Game code multiplies its dt by `value` each frame.
 */
export class TimeScale {
  value = 1;

  private freezeTimer = 0;
  private slowTimer = 0;
  private slowAmount = 1;

  // Bullet-time: hold deep slow-mo, then ease smoothly back to full speed.
  private btHold = 0;
  private btEase = 0;
  private btEaseDur = 1;
  private btScale = 1;

  /** Snap back to full speed immediately, clearing any freeze / slow-mo / bullet-time. */
  reset(): void {
    this.freezeTimer = 0;
    this.slowTimer = 0;
    this.slowAmount = 1;
    this.btHold = 0;
    this.btEase = 0;
    this.value = 1;
  }

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

  /**
   * Cinematic "bullet time" for a contact hit: hold deep slow-mo for `hold` seconds, then
   * ease back to full speed over `ease` seconds (a long, dramatic ramp-out).
   */
  bulletTime(scale = 0.16, hold = 0.5, ease = 0.8): void {
    this.btScale = scale;
    this.btHold = hold;
    this.btEase = ease;
    this.btEaseDur = ease;
  }

  /** Advance using REAL (unscaled) dt; returns the time scale to apply this frame. */
  update(realDt: number): number {
    if (this.freezeTimer > 0) {
      this.freezeTimer -= realDt;
      this.value = 0;
      return 0;
    }
    let v = 1;
    if (this.slowTimer > 0) {
      this.slowTimer -= realDt;
      v = Math.min(v, this.slowAmount);
    }
    // Bullet time takes over: full slow-mo through the hold, then a smooth ramp back to 1.
    if (this.btHold > 0 || this.btEase > 0) {
      let bt: number;
      if (this.btHold > 0) {
        this.btHold -= realDt;
        bt = this.btScale;
      } else {
        this.btEase -= realDt;
        const k = Math.max(0, Math.min(1, this.btEase / this.btEaseDur)); // 1 -> 0 over the ease
        const s = k * k * (3 - 2 * k); // smoothstep
        bt = this.btScale + (1 - this.btScale) * (1 - s); // btScale -> 1
      }
      v = Math.min(v, bt);
    }
    this.value = v;
    return v;
  }
}
