// Executed inside the existing platform container. Its private signing key
// never crosses stdout, an argv value, the realtime container, or a host log.
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
const mode = process.argv[2];
if (!['drain', 'cancel'].includes(mode)) throw new Error('Invalid drain operation');
const keyId = process.env.REALTIME_KEY_ID, keyPath = process.env.REALTIME_SIGNING_KEY_FILE;
const origin = process.env.REALTIME_INTERNAL_URL;
if (!keyId || !keyPath || !origin) throw new Error('The platform realtime bridge is not configured');
const path = `/internal/realtime/v1/${mode === 'drain' ? 'drain' : 'cancel-drain'}`;
const envelope = { keyId, nonce: randomBytes(24).toString('base64url'), issuedAt: Date.now(), method: 'POST', path, body: {} };
const canonical = JSON.stringify(envelope, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value);
const key = createPrivateKey(readFileSync(keyPath));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('The platform signing key must be Ed25519');
const signature = sign(null, Buffer.from(`iva-bridge-v1\n${canonical}`), key).toString('base64url');
const response = await fetch(new URL(path, origin), { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...envelope, signature }), signal: AbortSignal.timeout(30_000), redirect: 'error' });
if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) throw new Error(`Realtime ${mode} refused (HTTP ${response.status})`);
const result = await response.json();
if (result.ok !== true || (mode === 'drain' && (result.manifest?.schema !== 1 || !Array.isArray(result.manifest.matches)))) throw new Error('Invalid durable drain receipt');
process.stdout.write(JSON.stringify(result) + '\n');
