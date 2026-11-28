/** Content-addressed executable archives. Format 1 remains readable verbatim. */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ArtifactManifest { format: 1; artifactId: string; files: string[] }
const relativeFile = /^(?:assets\/)?[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/;
export const CONTENT_ID = /^sha256:[0-9a-f]{64}$/;
function flush(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function regularFile(directory: string, file: string): boolean {
  return relativeFile.test(file) && (!file.startsWith('assets/') || lstatSync(join(directory, 'assets')).isDirectory()) && lstatSync(join(directory, file)).isFile();
}
function digest(directory: string, files: string[]): string {
  const hasher = createHash('sha256');
  for (const file of files) {
    if (!regularFile(directory, file)) throw new Error('INVALID_RUNTIME_ARTIFACT');
    hasher.update(file); hasher.update(readFileSync(join(directory, file)));
  }
  return 'sha256:' + hasher.digest('hex');
}
export function artifactPath(root: string, artifactId: string): string {
  if (!CONTENT_ID.test(artifactId)) throw new Error('UNSUPPORTED_SAVED_RUNTIME');
  return resolve(root, artifactId.slice(7));
}
export function verifyRuntimeArtifact(root: string, artifactId: string): { directory: string; manifest: ArtifactManifest } {
  const directory = artifactPath(root, artifactId);
  if (!lstatSync(directory).isDirectory() || !lstatSync(join(directory, 'package.json')).isFile() ||
    !lstatSync(join(directory, 'manifest.json')).isFile() ||
    readFileSync(join(directory, 'package.json'), 'utf8') !== '{"type":"module"}\n') throw new Error('INVALID_RUNTIME_ARTIFACT');
  const manifest: unknown = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('INVALID_RUNTIME_ARTIFACT');
  const value = manifest as ArtifactManifest;
  if (value.format !== 1 || value.artifactId !== artifactId || !Array.isArray(value.files) || value.files.length > 128 ||
    new Set(value.files).size !== value.files.length || !value.files.includes('simulation-worker.js') ||
    value.files.some(file => typeof file !== 'string' || !relativeFile.test(file)) || digest(directory, value.files) !== artifactId) throw new Error('INVALID_RUNTIME_ARTIFACT');
  const allowed = new Set(['package.json', 'manifest.json', ...value.files]);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'assets' && entry.isDirectory()) {
      for (const file of readdirSync(join(directory, 'assets'), { withFileTypes: true })) {
        if (!file.isFile() || !allowed.has('assets/' + file.name)) throw new Error('INVALID_RUNTIME_ARTIFACT');
      }
    } else if (!entry.isFile() || !allowed.has(entry.name)) throw new Error('INVALID_RUNTIME_ARTIFACT');
  }
  return { directory, manifest: value };
}
export function retainedWorkerDirectory(root: string, artifactId: string): URL {
  return pathToFileURL(verifyRuntimeArtifact(root, artifactId).directory + '/');
}
export function runtimeArtifactManifest(source: URL): ArtifactManifest {
  const directory = fileURLToPath(source);
  const required = ['main.js', 'simulation-worker.js', 'store-worker.js'];
  // Preserve legacy ordering, then cover every new entry, including checkpoint
  // and retention CLI workers. No current root JS can silently miss the hash.
  const extra = readdirSync(directory).filter(name => name.endsWith('.js') && !required.includes(name)).sort();
  const assets = existsSync(join(directory, 'assets')) ? readdirSync(join(directory, 'assets')).filter(name => name.endsWith('.js')).sort().map(name => 'assets/' + name) : [];
  const files = [...required, ...extra, ...assets];
  if (files.length > 128) throw new Error('INVALID_RUNTIME_ARTIFACT');
  return { format: 1, artifactId: digest(directory, files), files };
}
function install(source: string, root: string, manifest: ArtifactManifest): URL {
  const target = artifactPath(root, manifest.artifactId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    const temporary = join(root, '.pending-' + randomUUID()); mkdirSync(temporary, { mode: 0o700 });
    try {
      const directories = new Set([temporary]);
      for (const file of manifest.files) {
        mkdirSync(dirname(join(temporary, file)), { recursive: true, mode: 0o700 });
        copyFileSync(join(source, file), join(temporary, file)); flush(join(temporary, file)); directories.add(dirname(join(temporary, file)));
      }
      writeFileSync(join(temporary, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
      writeFileSync(join(temporary, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      if (digest(temporary, manifest.files) !== manifest.artifactId) throw new Error('INVALID_RUNTIME_ARTIFACT');
      flush(join(temporary, 'package.json')); flush(join(temporary, 'manifest.json'));
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) flush(directory);
      try { renameSync(temporary, target); }
      catch (error) { if (!existsSync(target)) throw error; }
      flush(root);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return retainedWorkerDirectory(root, manifest.artifactId);
}
export function retainRuntimeArtifact(source: URL, root: string): { artifactId: string; workerDirectory: URL } {
  const manifest = runtimeArtifactManifest(source);
  return { artifactId: manifest.artifactId, workerDirectory: install(fileURLToPath(source), root, manifest) };
}
export function copyRuntimeArtifact(sourceRoot: string, destinationRoot: string, artifactId: string): URL {
  const { directory, manifest } = verifyRuntimeArtifact(sourceRoot, artifactId);
  return install(directory, destinationRoot, manifest);
}
