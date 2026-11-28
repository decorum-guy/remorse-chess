import { parentPort, workerData } from 'node:worker_threads';
import { RealtimeStore } from './store.js';
import type { StoredMatch, StoredStart } from './store.js';
import { StoreQueue } from './store-queue.js';
import { WorkerRpc } from './worker-rpc.js';
import { assertCheckpointBudget } from './checkpoint.js';
import type { CheckpointStatus } from './checkpoint.js';
import { TimingHistogram } from './timing.js';
const path = (workerData as {path: string}).path;
const store = new RealtimeStore(path, { separateCheckpoint: true });
const checkpoint = new WorkerRpc(new URL('./checkpoint-worker.js', import.meta.url), { path });
let checkpointStatus: CheckpointStatus | null = null, checkpointFailed = false, closing = false;
checkpoint.worker.on('message', (message: { type?: string; status?: CheckpointStatus }) => {
  if (message.type === 'checkpointMetrics' && message.status) checkpointStatus = message.status;
});
checkpoint.worker.on('error', () => { checkpointFailed = true; });
checkpoint.worker.on('exit', () => { if (!closing) checkpointFailed = true; });
try { checkpointStatus = await checkpoint.call<CheckpointStatus>('status'); }
catch (error) { await checkpoint.stop(); store.close(); throw error; }
const queueTiming = new TimingHistogram();
const reads = new Set(['status', 'list', 'compatibilityManifests', 'get', 'byStart', 'starts', 'receipt', 'checkAdmission', 'outbox']);
const guard = () => { if (checkpointFailed) throw new Error('CHECKPOINT_UNAVAILABLE'); assertCheckpointBudget(checkpointStatus, path); };
async function close() {
  closing = true;
  try { await checkpoint.call('close'); }
  finally { await checkpoint.stop(); store.close(); }
}
const queue = new StoreQueue(message => {
    if (!reads.has(message.op) && message.op !== 'close') guard();
    const a = message.args;
    let value: unknown;
    switch (message.op) {
      case 'status': value = store.status(); break;
      case 'list': value = store.list(); break;
      case 'compatibilityManifests': value = store.compatibilityManifests(); break;
      case 'get': value = store.get(a[0] as string); break;
      case 'byStart': value = store.byStart(a[0] as string); break;
      case 'create': value = store.create(a[0] as StoredMatch, a[1] as string, a[2] as string | undefined); break;
      case 'acquire': value = store.acquire(a[0] as string, a[1] as string); break;
      case 'starts': value = store.starts(); break;
      case 'enqueueStart': value = store.enqueueStart(a[0] as Pick<StoredStart, 'startId' | 'hostId' | 'fingerprint' | 'requestJson'>); break;
      case 'reserveStart': value = store.reserveStart(a[0] as string, a[1] as string, a[2] as string, a[3] as string); break;
      case 'releaseStart': value = store.releaseStart(a[0] as string, a[1] as string, a[2] as string); break;
      case 'cancelStart': value = store.cancelStart(a[0] as string, a[1] as string); break;
      case 'receipt': value = store.receipt(a[0] as string, a[1] as string); break;
      case 'consumeTicket': value = store.consumeTicket(a[0] as string, a[1] as number); break;
      case 'consumeBridge': value = store.consumeBridge(a[0] as string); break;
      case 'admission': value = store.admission(a[0] as string, a[1] as string, a[2] as number); break;
      case 'checkAdmission': value = store.checkAdmission(a[0] as string, a[1] as string); break;
      case 'revoke': value = store.revoke(a[0] as string); break;
      case 'release': value = store.release(a[0] as string); break;
      case 'outbox': value = store.outbox(); break;
      case 'delivered': value = store.delivered(a[0] as string, a[1] as string); break;
      case 'close': value = close(); break;
      default: throw new Error('UNKNOWN_STORE_OPERATION');
    }
    return value;
}, values => { guard(); return store.commitBatch(values); }, reply => parentPort!.postMessage(reply),
() => ({ writer: { ...store.writerMetrics(), queueP99Ms: queueTiming.p99(), checkpoint: checkpointStatus } }),
milliseconds => queueTiming.record(milliseconds));
parentPort!.on('message', message => queue.enqueue(message));
