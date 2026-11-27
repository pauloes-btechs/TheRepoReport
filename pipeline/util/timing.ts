/** Wall-clock stopwatch in seconds. */
export function stopwatch(): () => number {
  const start = performance.now();
  return () => round((performance.now() - start) / 1000);
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
