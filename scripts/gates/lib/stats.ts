/** Percentiles by nearest-rank, which is the honest choice for n = 20. */

export type Stats = {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
};

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  // Nearest-rank: ceil(p/100 * n), 1-indexed. No interpolation, so every
  // reported number is a number we actually measured.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export function stats(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return { n: 0, min: NaN, p50: NaN, p95: NaN, max: NaN, mean: NaN };
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n,
    min: s[0]!,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[n - 1]!,
    mean: Math.round((sum / n) * 10) / 10,
  };
}

export function fmtMs(v: number): string {
  return Number.isFinite(v) ? `${Math.round(v)} ms` : "n/a";
}
