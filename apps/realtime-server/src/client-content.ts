import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalJson } from '@iva-games/session-kit';
import { RealtimeError } from '@iva-games/realtime-kit';

const MANIFEST = '.iva-client-manifest.json';
export interface ClientMetadata { gameId: string; route: string; rulesVersion: string; contentVersion: string }
interface ClientManifest extends ClientMetadata { schema: 1; sha256: string; createdAt: number; files: { path: string; sha256: string }[] }
export interface ClientContent { sha256: string; directory: string; route: string; manifest: ClientManifest }
export interface ClientReference { sha256: string; route: string }
const digest = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
const sync = (path: string): void => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
function metadata(value: ClientMetadata): ClientMetadata {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value.gameId) || value.route !== `/play/${value.gameId}/` ||
    typeof value.rulesVersion !== 'string' || typeof value.contentVersion !== 'string' || !value.rulesVersion || !value.contentVersion) throw new RealtimeError('CLIENT_CONTENT_INVALID', 503);
  return { gameId: value.gameId, route: value.route, rulesVersion: value.rulesVersion, contentVersion: value.contentVersion };
}
function files(directory: string): string[] {
  const result: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (path === directory && entry.name === MANIFEST) continue;
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) throw new RealtimeError('CLIENT_CONTENT_INVALID', 503);
      const next = join(path, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) result.push(relative(directory, next).split(sep).join('/'));
      else throw new RealtimeError('CLIENT_CONTENT_INVALID', 503);
    }
  };
  visit(directory); return result.sort();
}
function contentDigest(directory: string, paths: string[], meta: ClientMetadata): string {
  const hash = createHash('sha256').update(canonicalJson(metadata(meta))).update('\0');
  for (const path of paths) hash.update(path).update('\0').update(readFileSync(join(directory, path))).update('\0');
  return hash.digest('hex');
}
/** Only bytes copied from this deployment's built public client are archived.
 * A saved hash cannot select a URL, arbitrary path, or an unverified directory. */
export function readClientContent(archive: string, sha256: string): ClientContent {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new RealtimeError('CLIENT_CONTENT_UNAVAILABLE', 409);
  const directory = resolve(archive, sha256);
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) throw new RealtimeError('CLIENT_CONTENT_UNAVAILABLE', 409);
  try {
    const manifest = JSON.parse(readFileSync(join(directory, MANIFEST), 'utf8')) as ClientManifest;
    const paths = files(directory);
    if (manifest.schema !== 1 || manifest.sha256 !== sha256 || !Number.isFinite(manifest.createdAt) || !paths.includes('index.html') ||
      !Array.isArray(manifest.files) || JSON.stringify(paths) !== JSON.stringify(manifest.files.map(file => file.path)) ||
      contentDigest(directory, paths, manifest) !== sha256 || manifest.files.some(file => digest(readFileSync(join(directory, file.path))) !== file.sha256)) throw new Error('Invalid client archive');
    return { sha256, directory, route: `${manifest.route}versions/${sha256}/`, manifest };
  } catch { throw new RealtimeError('CLIENT_CONTENT_CORRUPT', 409); }
}
export function archiveCurrentClient(sourcePath: string, archive: string, meta: ClientMetadata): ClientContent {
  const source = resolve(sourcePath), paths = files(source);
  if (!paths.includes('index.html') || existsSync(join(source, MANIFEST))) throw new RealtimeError('CLIENT_CONTENT_INVALID', 503);
  // A version-specific document must resolve scripts/styles inside its own
  // archived directory. Vite base './' also keeps runtime model/audio URLs local.
  if (/(?:src|href)=["']\//i.test(readFileSync(join(source, 'index.html'), 'utf8'))) throw new RealtimeError('CLIENT_BASE_NOT_RELATIVE', 503);
  const sha256 = contentDigest(source, paths, meta), target = join(archive, sha256);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  if (existsSync(target)) return readClientContent(archive, sha256);
  const staging = join(archive, `.staging-${randomUUID()}`); mkdirSync(staging, { mode: 0o700 });
  try {
    const manifest: ClientManifest = { ...metadata(meta), schema: 1, sha256, createdAt: Date.now(), files: [] };
    for (const path of paths) {
      const destination = join(staging, path); mkdirSync(resolve(destination, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, path), destination); chmodSync(destination, 0o400); sync(destination);
      manifest.files.push({ path, sha256: digest(readFileSync(destination)) });
    }
    writeFileSync(join(staging, MANIFEST), JSON.stringify(manifest), { mode: 0o400, flag: 'wx' }); sync(join(staging, MANIFEST));
    for (const directory of new Set(paths.map(path => resolve(staging, path, '..')))) sync(directory);
    sync(staging); renameSync(staging, target); sync(archive);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return readClientContent(archive, sha256);
}
export function availableClientContents(archive: string): ClientContent[] {
  if (!existsSync(archive)) return [];
  return readdirSync(archive).filter(name => /^[a-f0-9]{64}$/.test(name)).flatMap(name => {
    try { return [readClientContent(archive, name)]; } catch { return []; }
  });
}
