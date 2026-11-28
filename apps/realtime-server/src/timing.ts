/** Fixed-memory histogram; quantiles are rounded upward to 0.1 ms. */
export class TimingHistogram {
  private readonly bins = new Uint32Array(10001);
  private count = 0;
  private maximum = 0;
  record(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.count++; this.maximum = Math.max(this.maximum, milliseconds);
    this.bins[Math.min(10000, Math.ceil(milliseconds * 10))]++;
  }
  p99(): number {
    const needed = Math.ceil(this.count * 0.99); if (!needed) return 0;
    let count = 0;
    for (let i = 0; i < this.bins.length; i++) { count += this.bins[i]; if (count >= needed) return i === 10000 ? Math.max(1000, this.maximum) : i / 10; }
    return this.maximum;
  }
}
