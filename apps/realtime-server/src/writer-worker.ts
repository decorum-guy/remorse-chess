import { parentPort, workerData } from 'node:worker_threads';
import { LocalStorageClient, RealtimeStore } from './storage.js';
import type { StorageMethod } from './storage.js';
import { failure } from './rpc.js';

const port = parentPort;
if (!port) throw new Error('Writer requires worker_threads');
const store = new RealtimeStore((workerData as { databasePath: string }).databasePath);
const client = new LocalStorageClient(store);
let queue = Promise.resolve();
port.on('message', (message: { id: number; method: StorageMethod; args: unknown[] }) => {
  queue = queue.then(async () => {
    try {
      const value = await client.call(message.method, ...(message.args as Parameters<RealtimeStore[StorageMethod]>));
      port.postMessage({ id: message.id, value });
    } catch (error) { port.postMessage({ id: message.id, error: failure(error) }); }
  });
});
port.postMessage({ ready: true });
