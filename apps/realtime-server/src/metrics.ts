/** Fixed buckets and a fixed recent window: no payloads or unbounded samples.
 * Histogram quantiles are conservative upper bounds for the entire lifetime;
 * recent quantiles are exact only for the explicitly reported last 2048 samples. */
export const TIMING_BOUNDS_MS = [0, .125, .25, .5, .75, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 25 / 3,
  9, 10, 12, 15, 50 / 3, 20, 25, 30, 100 / 3, 40, 50, 60, 75, 100, 150, 200, 250, 500, 1000, 2000, 5000] as const;
const WINDOW_SIZE = 2048;
export interface TimingReport {
  count: number; totalMs: number; maxMs: number; p50UpperMs: number | null; p95UpperMs: number | null; p99UpperMs: number | null;
  buckets: { upperMs: number | null; count: number }[];
  recent: { count: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null };
}
export class BoundedTiming {
  private readonly buckets = new Float64Array(TIMING_BOUNDS_MS.length + 1);
  private readonly recent = new Float64Array(WINDOW_SIZE);
  private count = 0;
  private total = 0;
  private max = 0;
  observe(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    let bucket = TIMING_BOUNDS_MS.findIndex(limit => milliseconds <= limit);
    if (bucket === -1) bucket = TIMING_BOUNDS_MS.length;
    this.buckets[bucket] += 1;
    this.recent[this.count % WINDOW_SIZE] = milliseconds;
    this.count += 1; this.total += milliseconds; this.max = Math.max(this.max, milliseconds);
  }
  report(): TimingReport {
    const quantile = (fraction: number): number | null => {
      if (!this.count) return null;
      let accumulated = 0;
      for (let index = 0; index < this.buckets.length; index++) {
        accumulated += this.buckets[index];
        if (accumulated >= Math.ceil(this.count * fraction)) return TIMING_BOUNDS_MS[index] ?? null;
      }
      return null;
    };
    const count = Math.min(this.count, WINDOW_SIZE), recent = Array.from(this.recent.subarray(0, count)).sort((a, b) => a - b);
    const point = (fraction: number): number | null => count ? recent[Math.ceil(count * fraction) - 1] : null;
    return { count: this.count, totalMs: this.total, maxMs: this.max, p50UpperMs: quantile(.5), p95UpperMs: quantile(.95), p99UpperMs: quantile(.99),
      buckets: Array.from(this.buckets, (value, index) => ({ upperMs: TIMING_BOUNDS_MS[index] ?? null, count: value })),
      recent: { count, p50Ms: point(.5), p95Ms: point(.95), p99Ms: point(.99) } };
  }
}
export class GameTimings {
  readonly step = new BoundedTiming();
  readonly commit = new BoundedTiming();
  readonly serialize = new BoundedTiming();
  readonly uncommitted = new BoundedTiming();
  readonly snapshotAge = new BoundedTiming();
  report() { return { step: this.step.report(), commit: this.commit.report(), serialize: this.serialize.report(),
    uncommitted: this.uncommitted.report(), snapshotAge: this.snapshotAge.report() }; }
}
