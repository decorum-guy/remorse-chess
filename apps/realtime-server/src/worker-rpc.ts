import { Worker } from 'node:worker_threads';
export class WorkerRpc {
  private next = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>();
  readonly worker: Worker;
  constructor(url: URL, workerData?: unknown) {
    this.worker = new Worker(url, { workerData });
    this.worker.on('message', (reply: {id: number; value?: unknown; error?: string}) => {
      const task = this.pending.get(reply.id); if (!task) return;
      clearTimeout(task.timer); this.pending.delete(reply.id);
      if (reply.error) task.reject(new Error(reply.error)); else task.resolve(reply.value);
    });
    const fail = () => { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('WORKER_UNAVAILABLE')); } this.pending.clear(); };
    this.worker.on('error', fail); this.worker.on('exit', fail);
  }
  call<T>(op: string, ...args: unknown[]): Promise<T> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('WORKER_DEADLINE')); }, 5000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.worker.postMessage({ id, op, args });
    });
  }
  async stop(): Promise<void> { await this.worker.terminate(); }
}
