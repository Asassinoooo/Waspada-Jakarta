// Latency statistics for the performance tests (NFR-04). Samples are in milliseconds.
// Percentiles use the nearest-rank method, as tools/evaluation/model-benchmark.ts does.
// The p95 interval is a seeded bootstrap, so a rerun on the same samples gives the same interval.

export interface LatencySummary {
  readonly n: number;
  readonly mean: number;
  readonly sd: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly p95_ci95: readonly [number, number];
}

export function nearestRank(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapP95Ci(
  samples: readonly number[],
  resamples = 10_000,
  seed = 20261113,
): readonly [number, number] {
  const n = samples.length;
  if (n === 0) return [Number.NaN, Number.NaN];
  const rand = mulberry32(seed);
  const estimates: number[] = [];
  const buffer: number[] = new Array<number>(n);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) buffer[i] = samples[Math.floor(rand() * n)]!;
    buffer.sort((x, y) => x - y);
    estimates.push(nearestRank(buffer, 0.95));
  }
  estimates.sort((x, y) => x - y);
  return [nearestRank(estimates, 0.025), nearestRank(estimates, 0.975)];
}

export function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((x, y) => x - y);
  const n = sorted.length;
  const mean = n === 0 ? Number.NaN : sorted.reduce((sum, x) => sum + x, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(sorted.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (n - 1));
  return {
    n,
    mean,
    sd,
    min: sorted[0] ?? Number.NaN,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: sorted[n - 1] ?? Number.NaN,
    p95_ci95: bootstrapP95Ci(samples),
  };
}
