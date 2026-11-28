import { parentPort, workerData } from 'node:worker_threads';
import { WalCheckpointer } from './checkpoint.js';

const checkpoint = new WalCheckpointer((workerData as { path: string }).path);
const publish = () => { const status = checkpoint.poll(); parentPort!.postMessage({ type: 'checkpointMetrics', status }); return status; };
const timer = setInterval(publish, 250); timer.unref();
parentPort!.on('message', (message: { id: number; op: string }) => {
  try {
    if (message.op === 'status') parentPort!.postMessage({ id: message.id, value: publish() });
    else if (message.op === 'close') { clearInterval(timer); checkpoint.close(); parentPort!.postMessage({ id: message.id }); }
    else throw new Error('UNKNOWN_CHECKPOINT_OPERATION');
  } catch (error) { parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : 'CHECKPOINT_FAILED' }); }
});
