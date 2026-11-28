/** Content-addressed public assets; saved games retain the client that created them. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONTENT_ID } from './artifacts.js';
export interface ClientManifest { format: 1; contentId: string; files: string[] }
const safeName = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const verified = new Map<string, string>();
function flush(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function inventory(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (!safeName.test(name)) throw new Error('INVALID_CLIENT_CONTENT');
    if (entry.isDirectory()) files.push(...inventory(root, name + '/'));
    else if (entry.isFile()) files.push(name);
    else throw new Error('INVALID_CLIENT_CONTENT');
  }
  return files.sort();
}
function identity(directory: string, files: string[]): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(files.map(file => {
    if (!safeName.test(file)) throw new Error('INVALID_CLIENT_CONTENT');
    const parts = file.split('/'); let path = directory;
    for (const [index, part] of parts.entries()) {
      path = join(path, part); const stat = lstatSync(path);
      if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error('INVALID_CLIENT_CONTENT');
    }
    return [file, createHash('sha256').update(readFileSync(path)).digest('hex')];
  }))).digest('hex');
}
export function verifyClientContent(root: string, contentId: string): { directory: string; manifest: ClientManifest } {
  if (!CONTENT_ID.test(contentId)) throw new Error('UNSUPPORTED_CLIENT_CONTENT');
  const directory = resolve(root, contentId.slice(7));
  if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, '_content-manifest.json')).isFile()) throw new Error('INVALID_CLIENT_CONTENT');
  const value: unknown = JSON.parse(readFileSync(join(directory, '_content-manifest.json'), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CLIENT_CONTENT');
  const manifest = value as ClientManifest;
  if (manifest.format !== 1 || manifest.contentId !== contentId || !Array.isArray(manifest.files) ||
    manifest.files.length > 10_000 || !manifest.files.includes('index.html') || manifest.files.includes('_content-manifest.json') || new Set(manifest.files).size !== manifest.files.length ||
    manifest.files.some(file => typeof file !== 'string' || !safeName.test(file)) || identity(directory, manifest.files) !== contentId ||
    JSON.stringify(inventory(directory).filter(file => file !== '_content-manifest.json')) !== JSON.stringify([...manifest.files].sort())) throw new Error('INVALID_CLIENT_CONTENT');
  return { directory, manifest };
}
export function retainedClientDirectory(root: string, contentId: string): string {
  const cacheKey = resolve(root) + ':' + contentId;
  if (verified.has(cacheKey)) return verified.get(cacheKey)!;
  const directory = verifyClientContent(root, contentId).directory;
  verified.set(cacheKey, directory); return directory;
}
function install(source: string, root: string, manifest: ClientManifest): string {
  const target = resolve(root, manifest.contentId.slice(7)); mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    const temporary = join(root, '.pending-' + randomUUID()); mkdirSync(temporary, { mode: 0o700 });
    try {
      const directories = new Set([temporary]);
      for (const file of manifest.files) {
        const destination = join(temporary, file); mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        copyFileSync(join(source, file), destination); flush(destination);
        for (let directory = dirname(destination); directory.startsWith(temporary); directory = dirname(directory)) directories.add(directory);
      }
      if (identity(temporary, manifest.files) !== manifest.contentId) throw new Error('INVALID_CLIENT_CONTENT');
      writeFileSync(join(temporary, '_content-manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      flush(join(temporary, '_content-manifest.json'));
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) flush(directory);
      try { renameSync(temporary, target); } catch (error) { if (!existsSync(target)) throw error; }
      flush(root);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  // Installation/preflight always reads the bytes, regardless of the HTTP cache.
  const directory = verifyClientContent(root, manifest.contentId).directory;
  verified.set(resolve(root) + ':' + manifest.contentId, directory); return directory;
}
export function clientContentManifest(source: string): ClientManifest {
  const files = inventory(source); if (!files.includes('index.html') || files.includes('_content-manifest.json')) throw new Error('CLIENT_BUILD_REQUIRED');
  return { format: 1, contentId: identity(source, files), files };
}
export function retainClientContent(source: string, root: string): { contentId: string; directory: string } {
  const manifest = clientContentManifest(source);
  return { contentId: manifest.contentId, directory: install(source, root, manifest) };
}
export function copyClientContent(sourceRoot: string, destinationRoot: string, contentId: string): string {
  const { directory, manifest } = verifyClientContent(sourceRoot, contentId);
  return install(directory, destinationRoot, manifest);
}
