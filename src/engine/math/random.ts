/** Small RNG helpers used across AI, fumbles, and FX. */

export function rand(min = 0, max = 1): number {
  return min + Math.random() * (max - min);
}

export function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function chance(p: number): boolean {
  return Math.random() < p;
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Random unit-ish offset within a circle of `radius`. */
export function jitter(radius: number): { x: number; y: number } {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * radius;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}
