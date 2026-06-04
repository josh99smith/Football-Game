/**
 * Fixed-timestep game loop with an accumulator. The simulation always advances in
 * constant `STEP` increments (deterministic, stable physics/feel) while rendering
 * happens once per animation frame with an interpolation alpha for smoothness.
 */
export const STEP = 1 / 60; // simulation runs at 60 Hz

export type UpdateFn = (dt: number) => void;
export type RenderFn = (alpha: number) => void;

export class Loop {
  private rafId = 0;
  private last = 0;
  private accumulator = 0;
  private running = false;

  constructor(
    private readonly update: UpdateFn,
    private readonly render: RenderFn,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    // Convert ms to seconds; clamp to avoid a "spiral of death" after a tab stall.
    let frameTime = (now - this.last) / 1000;
    this.last = now;
    if (frameTime > 0.25) frameTime = 0.25;

    this.accumulator += frameTime;
    let steps = 0;
    while (this.accumulator >= STEP) {
      this.update(STEP);
      this.accumulator -= STEP;
      // Hard cap steps per frame so a slow device degrades gracefully.
      if (++steps >= 5) {
        this.accumulator = 0;
        break;
      }
    }

    this.render(this.accumulator / STEP);
  };
}
