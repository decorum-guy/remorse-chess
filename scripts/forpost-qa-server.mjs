/** Isolated local test stack; never used by production deployment. */
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const runDirectory = resolve(root, '.qa/forpost/e2e-' + randomUUID());
await mkdir(runDirectory, { recursive: true, mode: 0o700 });
const origin = 'http://127.0.0.1:5274';
const revision = process.env.IVA_BUILD_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const pair = generateKeyPairSync('ed25519');
const keyPath = resolve(runDirectory, 'platform-signing.pem'), trustedPath = resolve(runDirectory, 'trusted.json');
await writeFile(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
await writeFile(trustedPath, JSON.stringify({ 'qa-platform-v1': pair.publicKey.export({ type: 'spki', format: 'pem' }) }), { mode: 0o600 });
const mailDirectory = resolve(runDirectory, 'mail');
await writeFile(resolve(root, '.qa/forpost/current-e2e.json'), JSON.stringify({ origin, revision, runDirectory, mailDirectory }), { mode: 0o600 });
const children = [];
let closing = false;
function child(file, extra) {
  const processChild = spawn(process.execPath, [file], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NODE_ENV: 'development', IVA_BUILD_SHA: revision, ...extra } });
  children.push(processChild);
  processChild.on('exit', code => { if (!closing) { console.error(`QA child ${file} exited: ${code}`); close(); process.exitCode = 1; } });
}
child('dist-realtime/main.js', { REALTIME_PORT: '4274', REALTIME_HOST: '127.0.0.1', REALTIME_PUBLIC_ORIGIN: origin,
  REALTIME_DATABASE_PATH: resolve(runDirectory, 'realtime.sqlite'), REALTIME_PRACTICE_KEY_PATH: resolve(runDirectory, 'practice.pem'),
  REALTIME_TRUSTED_KEYS_PATH: trustedPath, REALTIME_ARTIFACT_DIRECTORY: resolve(runDirectory, 'artifacts') });
child('dist-platform/main.js', { PLATFORM_HOST: '127.0.0.1', PLATFORM_PORT: '4275', PORTAL_ORIGIN: origin,
  PLATFORM_DATABASE_PATH: resolve(runDirectory, 'platform.sqlite'), PLATFORM_LAB_DATABASE_PATH: resolve(runDirectory, 'lab.sqlite'),
  PORTAL_DIST_DIRECTORY: resolve(root, 'apps/portal/dist'), MAIL_MODE: 'file', MAIL_FILE_DIRECTORY: mailDirectory,
  TELEGRAM_ENABLED: 'false', TELEGRAM_AUTH_ENABLED: 'false', REALTIME_INTERNAL_ORIGIN: 'http://127.0.0.1:4274',
  REALTIME_SIGNING_KEY_PATH: keyPath, REALTIME_SIGNING_KEY_ID: 'qa-platform-v1' });
let ready = false;
const gateway = createServer((request, response) => {
  if (request.url === '/__qa/health') { response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ready, revision })); return; }
  const realtime = /^\/(?:play\/forpost|api\/realtime|realtime-assets)(?:\/|$)/.test(request.url ?? '');
  const upstream = httpRequest({ host: '127.0.0.1', port: realtime ? 4274 : 4275, path: request.url, method: request.method, headers: request.headers }, result => {
    response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('QA service unavailable'); }); request.pipe(upstream);
});
gateway.on('upgrade', (request, socket, head) => {
  if (request.url !== '/ws/realtime/v1') { socket.destroy(); return; }
  const upstream = createConnection({ host: '127.0.0.1', port: 4274 }, () => {
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n` + Object.entries(request.headers).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${value}`).join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
});
gateway.on('error', error => { console.error(error.message); close(); process.exitCode = 1; });
gateway.listen(5274, '127.0.0.1');
for (let attempt = 0; attempt < 100 && !closing; attempt++) {
  try {
    const responses = await Promise.all([fetch('http://127.0.0.1:4274/api/realtime/v1/health'), fetch('http://127.0.0.1:4275/api/platform/v1/session')]);
    if (responses.every(response => response.ok)) { ready = true; console.log(`Forpost isolated QA stack ready: ${origin} (${revision})`); break; }
  } catch { /* The children are starting. */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) { close(); throw new Error('QA stack did not become ready'); }
function close() { if (closing) return; closing = true; gateway.close(); for (const processChild of children) processChild.kill('SIGTERM'); }
process.once('SIGINT', close); process.once('SIGTERM', close);
