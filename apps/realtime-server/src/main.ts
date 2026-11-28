import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONTENT_VERSION, RULES_VERSION } from '@iva-games/tyaga/shared';
import { WorkerHost } from './worker-host.js';
import { createRealtimeHttpServer } from './server.js';
import { publicKeys } from './crypto.js';
import { archiveCurrentClient, availableClientContents } from './client-content.js';

process.umask(0o077);
const env = process.env;
const host = env.REALTIME_HOST ?? '127.0.0.1';
const port = Number(env.REALTIME_PORT ?? 4284);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid realtime port');
if (!env.REALTIME_TRUSTED_KEYS_FILE) throw new Error('REALTIME_TRUSTED_KEYS_FILE is required');
const keys = publicKeys(JSON.parse(readFileSync(env.REALTIME_TRUSTED_KEYS_FILE, 'utf8')) as Record<string, string>);
if (!keys.size) throw new Error('At least one trusted platform signing key is required');
const origins = (env.REALTIME_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5284,http://127.0.0.1:4285').split(',');
if (origins.some(origin => new URL(origin).origin !== origin || (env.NODE_ENV === 'production' && !origin.startsWith('https:')))) throw new Error('Invalid realtime origin');
const hosts = (env.REALTIME_ALLOWED_HOSTS ?? `127.0.0.1:${port},localhost:${port},127.0.0.1:5284,127.0.0.1:4285`).split(',');
const maxMatches = Number(env.REALTIME_MAX_MATCHES ?? 2);
if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 32) throw new Error('Invalid realtime capacity');
const databasePath = resolve(env.REALTIME_DATABASE_PATH ?? '.qa/tyaga/realtime.sqlite');
const clientDirectory = resolve(env.REALTIME_TYAGA_STATIC_DIRECTORY ?? 'games/tyaga/dist');
const clientArchive = join(dirname(databasePath), 'client-artifacts');
const currentClient = archiveCurrentClient(clientDirectory, clientArchive, { gameId: 'tyaga', route: '/play/tyaga/', rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION });
const retainedClients = availableClientContents(clientArchive);
const runtime = new WorkerHost({ databasePath, maxMatches,
  clients: { tyaga: { sha256: currentClient.sha256, route: currentClient.route } }, availableClientHashes: retainedClients.map(client => client.sha256),
  ...(env.REALTIME_ARTIFACT_DIRECTORY ? { artifactDirectory: resolve(env.REALTIME_ARTIFACT_DIRECTORY) } : {}) });
await runtime.ready;
const server = createRealtimeHttpServer({ runtime, storage: runtime.storage, trustedKeys: keys,
  allowedOrigins: origins, allowedHosts: hosts, revision: env.REALTIME_REVISION,
  staticDirectories: { '/play/tyaga/': clientDirectory, ...Object.fromEntries(retainedClients.map(client => [client.route, client.directory])) } });
server.listen(port, host, () => console.info(`Iva realtime listening on ${host}:${port}`));
let stopping = false;
const stop = (): void => {
  if (stopping) return; stopping = true;
  const deadline = setTimeout(() => { console.error('Realtime drain failed to finish; durable data retained'); process.exit(1); }, 30_000);
  void (async () => { await server.shutdown(); await runtime.close(); })().then(() => { clearTimeout(deadline); process.exit(0); }, () => { clearTimeout(deadline); console.error('Realtime shutdown failed; durable data retained'); process.exit(1); });
};
process.once('SIGINT', stop); process.once('SIGTERM', stop);
