/** Runs during image sealing and in a no-network, read-only host preflight. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkStoreCompatibility, sealRetentionBundle, verifyCurrentBundle } from './retention.js';

const [operation, ...arguments_] = process.argv.slice(2);
const values = new Map<string, string>();
let allowEmptyStore = false;
const allowed = new Set(['--input', '--output', '--runtime', '--client', '--revision', '--bundle', '--database']);
try {
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    if (flag === '--allow-empty-store' && !allowEmptyStore) { allowEmptyStore = true; continue; }
    const value = arguments_[++index];
    if (!allowed.has(flag) || values.has(flag) || !value || value.startsWith('--')) throw new Error('INVALID_RETENTION_COMMAND');
    values.set(flag, value);
  }
  const required = (flag: string, fallback?: string) => {
    const value = values.get(flag) ?? fallback; if (!value) throw new Error('INVALID_RETENTION_COMMAND'); return value;
  };
  const runtimeSource = values.has('--runtime') ? pathToFileURL(resolve(required('--runtime')) + '/') : new URL('./', import.meta.url);
  const clientSource = resolve(required('--client', process.env.REALTIME_STATIC_DIRECTORY));
  const buildRevision = required('--revision', process.env.IVA_BUILD_SHA);
  if (operation === 'seal') {
    if (allowEmptyStore || values.has('--database') || values.has('--bundle')) throw new Error('INVALID_RETENTION_COMMAND');
    const bundle = sealRetentionBundle({ inputDirectory: resolve(required('--input')), outputDirectory: resolve(required('--output')), runtimeSource, clientSource, buildRevision });
    console.info(JSON.stringify({ ok: true, operation, buildRevision, current: bundle.current, artifacts: bundle.artifacts.length, clients: bundle.clients.length, seal: bundle.seal }));
  } else if (operation === 'verify' || operation === 'check-store') {
    if (values.has('--input') || values.has('--output') || operation === 'verify' && (allowEmptyStore || values.has('--database'))) throw new Error('INVALID_RETENTION_COMMAND');
    const bundle = verifyCurrentBundle(resolve(required('--bundle', process.env.REALTIME_RETENTION_DIRECTORY)), runtimeSource, clientSource, buildRevision);
    const result = operation === 'check-store' ? checkStoreCompatibility(resolve(required('--database', process.env.REALTIME_DATABASE_PATH)), bundle, allowEmptyStore) : { ok: true, buildRevision, bundleSeal: bundle.seal };
    console.info(JSON.stringify({ operation, ...result }));
  } else throw new Error('INVALID_RETENTION_COMMAND');
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z_]{1,80}$/.test(message) ? message : 'RETENTION_CHECK_FAILED';
  console.error(JSON.stringify({ ok: false, operation: ['seal', 'verify', 'check-store'].includes(operation) ? operation : 'invalid', error: code }));
  process.exitCode = 1;
}
