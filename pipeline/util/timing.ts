/** Wall-clock stopwatch in seconds. */
export function stopwatch(): () => number {
  const start = performance.now();
  return () => round((performance.now() - start) / 1000);
}

/** Run `fn` and return its result plus elapsed seconds. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; seconds: number }> {
  const elapsed = stopwatch();
  const value = await fn();
  return { value, seconds: elapsed() };
}

export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
