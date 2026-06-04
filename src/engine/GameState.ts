/** A screen/phase of the game. The active state owns update + render each frame. */
export interface GameState {
  enter?(): void;
  exit?(): void;
  /** Advance simulation by `dt` seconds (already time-scaled). */
  update(dt: number): void;
  /** Draw the frame. `alpha` is the fixed-step interpolation remainder. */
  render(alpha: number): void;
}
