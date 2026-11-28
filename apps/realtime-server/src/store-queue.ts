import type { Commit } from './store.js';

export interface StoreRequest { id: number; op: string; args: unknown[] }
export interface StoreReply { id: number; value?: unknown; error?: string }

/** Keeps RPC arrival order and acknowledges only after the batch transaction. */
export class StoreQueue {
  private readonly queue: (StoreRequest & { queuedAt: number })[] = [];
  private scheduled = false;
  constructor(private readonly execute: (request: StoreRequest) => unknown,
    private readonly commit: (values: Commit[]) => { error?: string }[], private readonly reply: (reply: StoreReply) => void,
    private readonly metadata?: () => Record<string, unknown>, private readonly observeQueue?: (milliseconds: number) => void) {}

  enqueue(request: StoreRequest): void {
    this.queue.push({ ...request, queuedAt: performance.now() });
    if (!this.scheduled) { this.scheduled = true; setTimeout(() => { void this.flush(); }, 2); }
  }
  private async flush(): Promise<void> {
    const work = this.queue.splice(0, 64);
    for (let i = 0; i < work.length;) {
      const request = work[i];
      if (request.op !== 'commit') {
        this.observeQueue?.(performance.now() - request.queuedAt);
        try {
          const value = this.execute(request);
          this.reply({ id: request.id, value: value instanceof Promise ? await value : value });
        }
        catch (error) { this.reply({ id: request.id, error: error instanceof Error ? error.message : 'STORE_FAILED' }); }
        i++; continue;
      }
      const group: StoreRequest[] = [];
      while (i < work.length && work[i].op === 'commit' && group.length < 32) {
        this.observeQueue?.(performance.now() - work[i].queuedAt); group.push(work[i++]);
      }
      try {
        const results = this.commit(group.map(item => item.args[0] as Commit));
        for (const [index, item] of group.entries()) this.reply({ id: item.id, value: { batchSize: group.length, ...this.metadata?.() }, ...results[index] });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'STORE_FAILED';
        for (const item of group) this.reply({ id: item.id, error: message });
      }
    }
    if (this.queue.length) setImmediate(() => { void this.flush(); });
    else this.scheduled = false;
  }
}
