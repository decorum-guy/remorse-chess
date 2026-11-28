// One-time administrator preparation, never callable by the CI forced command.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [directory, keyId] = process.argv.slice(2);
if (process.getuid() !== 0 || !directory || !keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
  throw new Error('Run as administrator: node create-realtime-keys.mjs /absolute/key-directory key-id');
}
if (resolve(directory) !== directory || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
  throw new Error('An existing absolute, nonsymlink key directory is required');
}
const privatePath = join(directory, 'platform-private.pem'), publicPath = join(directory, 'trusted-public-keys.json');
if (existsSync(privatePath) || existsSync(publicPath)) throw new Error('Refusing to overwrite an existing or incomplete key pair');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o640 });
chownSync(privatePath, 0, 1000); chmodSync(privatePath, 0o640);
writeFileSync(publicPath, JSON.stringify({ [keyId]: publicPem }) + '\n', { flag: 'wx', mode: 0o644 });
chownSync(publicPath, 0, 0); chmodSync(publicPath, 0o644);
for (const path of [privatePath, publicPath, directory]) { const descriptor = openSync(path, 'r'); try { fsyncSync(descriptor); } finally { closeSync(descriptor); } }
console.log(JSON.stringify({ keyId, publicFingerprint: createHash('sha256').update(publicPem).digest('hex') }));
