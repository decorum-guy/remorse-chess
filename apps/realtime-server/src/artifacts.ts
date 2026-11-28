import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { RealtimeError } from '@iva-games/realtime-kit';

export const WORKER_PROTOCOL = 'iva-worker@1';
interface ArtifactManifest { protocol: typeof WORKER_PROTOCOL; sha256: string; createdAt: number; files: { path: string; sha256: string }[] }
export interface RuntimeArtifact { sha256: string; workerPath: string; manifest: ArtifactManifest }
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
function sync(path: string): void { const file = openSync(path, 'r'); try { fsyncSync(file); } finally { closeSync(file); } }
function executableFiles(directory: string): string[] {
  const paths: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new RealtimeError('ARTIFACT_SYMLINK', 503);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.js')) paths.push(relative(directory, file).split(sep).join('/'));
    }
  };
  visit(directory);
  return paths.sort();
}
function filesDigest(directory: string, files: string[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(readFileSync(join(directory, file))).update('\0');
  return hash.digest('hex');
}
/** Only a local, hash-named archive can be executed. Neither a client field nor
 * a saved URL can select a path or download code. The manifest is not trusted
 * until every executable byte matches its content-addressed directory name. */
export function readArtifact(archiveRoot: string, sha256: string): RuntimeArtifact {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new RealtimeError('ARTIFACT_UNAVAILABLE', 503);
  const directory = resolve(archiveRoot, sha256);
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) throw new RealtimeError('ARTIFACT_UNAVAILABLE', 503);
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as ArtifactManifest;
    const files = executableFiles(directory);
    if (manifest.protocol !== WORKER_PROTOCOL || manifest.sha256 !== sha256 || !Number.isFinite(manifest.createdAt) ||
        !files.includes('simulation-worker.js') || !Array.isArray(manifest.files) ||
        JSON.stringify(files) !== JSON.stringify(manifest.files.map(file => file.path)) ||
        filesDigest(directory, files) !== sha256 ||
        manifest.files.some(file => digest(readFileSync(join(directory, file.path))) !== file.sha256)) {
      throw new Error('Artifact hash mismatch');
    }
    return { sha256, workerPath: join(directory, 'simulation-worker.js'), manifest };
  } catch { throw new RealtimeError('ARTIFACT_CORRUPT', 503); }
}
/** Archive only the currently deployed, compiled bundle. Keep prior archives
 * with the durable volume; backup includes them. No time-based pruning can
 * discard code still referenced by a paused match or a retained checkpoint. */
export function archiveCurrentArtifact(compiledDirectory: string, archiveRoot: string): RuntimeArtifact {
  const source = resolve(compiledDirectory), files = executableFiles(source);
  if (!files.includes('simulation-worker.js')) throw new RealtimeError('ARTIFACT_UNAVAILABLE', 503);
  const sha256 = filesDigest(source, files), target = join(archiveRoot, sha256);
  mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  if (existsSync(target)) return readArtifact(archiveRoot, sha256);
  const staging = join(archiveRoot, `.staging-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const manifest: ArtifactManifest = { protocol: WORKER_PROTOCOL, sha256, createdAt: Date.now(), files: [] };
    for (const file of files) {
      const destination = join(staging, file);
      mkdirSync(resolve(destination, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(join(source, file), destination);
      manifest.files.push({ path: file, sha256: digest(readFileSync(destination)) });
      chmodSync(destination, 0o400);
      sync(destination);
    }
    // Explicit ESM scope: /data is independent of /app/package.json.
    writeFileSync(join(staging, 'package.json'), '{"type":"module","private":true}\n', { mode: 0o400, flag: 'wx' });
    writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest), { mode: 0o400, flag: 'wx' });
    sync(join(staging, 'package.json')); sync(join(staging, 'manifest.json'));
    for (const directory of new Set(files.map(file => resolve(staging, file, '..')))) sync(directory);
    sync(staging);
    renameSync(staging, target);
    sync(archiveRoot);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return readArtifact(archiveRoot, sha256);
}
