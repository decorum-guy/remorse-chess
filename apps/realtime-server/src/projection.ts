/** The cache accepts only one observer's already filtered projection. */
type Snapshot<T> = { type: 'full'; snapshotSeq: number; view: T } |
  { type: 'delta'; snapshotSeq: number; baselineSnapshotSeq: number; patch: Partial<T> };
export class ProjectionStream<T extends object> {
  private sequence = 0;
  private epoch = -1;
  private lastFullAt = 0;
  private acknowledged: number | null = null;
  private readonly sent = new Map<number, T>();
  reset(): void { this.acknowledged = null; this.sent.clear(); this.lastFullAt = 0; }
  acknowledge(sequence: number): void {
    if (this.sent.has(sequence) && (this.acknowledged === null || sequence > this.acknowledged)) this.acknowledged = sequence;
  }
  snapshot(view: T, epoch: number, forceFull = false, now = Date.now()): Snapshot<T> {
    if (epoch !== this.epoch) { this.reset(); this.epoch = epoch; }
    const baseline = this.acknowledged === null ? undefined : this.sent.get(this.acknowledged);
    const snapshotSeq = ++this.sequence;
    let result: Snapshot<T>;
    if (forceFull || !baseline || now - this.lastFullAt >= 2000 || Object.keys(baseline).some(key => !Object.hasOwn(view, key))) {
      this.lastFullAt = now; result = { type: 'full', snapshotSeq, view };
    } else {
      const patch: Partial<T> = {};
      for (const key of Object.keys(view) as (keyof T)[]) if (JSON.stringify(view[key]) !== JSON.stringify(baseline[key])) patch[key] = view[key];
      result = { type: 'delta', snapshotSeq, baselineSnapshotSeq: this.acknowledged!, patch };
    }
    this.sent.set(snapshotSeq, structuredClone(view));
    while (this.sent.size > 32) this.sent.delete(this.sent.keys().next().value!);
    return result;
  }
}
