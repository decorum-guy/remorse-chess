/** Builtins only: export on a git checkout, verify again inside a git-free image. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_DIRECTORIES = ['games/forpost/src', 'games/forpost/public',
  'apps/realtime-server/src', 'apps/realtime-server/scripts', 'packages/realtime-kit/src', 'packages/session-kit/src'];
export const SOURCE_FILES = ['package.json', 'package-lock.json', 'tsconfig.base.json', 'Dockerfile.realtime',
  'games/forpost/package.json', 'games/forpost/vite.config.ts', 'games/forpost/index.html',
  'apps/realtime-server/package.json', 'apps/realtime-server/vite.config.ts',
  'packages/realtime-kit/package.json', 'packages/session-kit/package.json',
  'packages/game-registry/games.json', 'deploy/iva-games/realtime-control.mjs',
  'deploy/iva-games/prepare-realtime-image.py'];
export const FORMAT = 'iva-forpost-source-2';
export const METHOD = 'SHA-256 of sorted relative paths then exact bytes; independent per-file SHA-256 and strict complete inventory';

export async function fingerprintSources(root) {
  const collect = async directory => {
    if (!(await lstat(resolve(root, directory))).isDirectory()) throw new Error('SOURCE_DIRECTORY_REQUIRED');
    const files = [];
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) files.push(...await collect(path));
      else if (entry.isFile()) files.push(path);
      else throw new Error('SOURCE_SYMLINK_OR_SPECIAL_FILE');
    }
    return files;
  };
  const paths = [...SOURCE_FILES];
  for (const directory of SOURCE_DIRECTORIES) paths.push(...await collect(directory));
  paths.sort();
  if (new Set(paths).size !== paths.length) throw new Error('SOURCE_DUPLICATE_PATH');
  const source = createHash('sha256'), core = createHash('sha256'), files = [];
  let coreFileCount = 0;
  for (const path of paths) {
    if (!(await lstat(resolve(root, path))).isFile()) throw new Error('SOURCE_FILE_REQUIRED');
    const bytes = await readFile(resolve(root, path)); source.update(path); source.update(bytes);
    if (path.startsWith('games/forpost/src/core/')) { core.update(path); core.update(bytes); coreFileCount++; }
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { sourceSha256: source.digest('hex'), sourceFileCount: paths.length, coreSha256: core.digest('hex'), coreFileCount, files };
}
export async function createSourceTrace(root) {
  const fingerprint = await fingerprintSources(root);
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
  if (!/^[0-9a-f]{40}$/.test(gitCommit)) throw new Error('INVALID_SOURCE_REVISION');
  return { format: FORMAT, gitCommit, dirty, ...fingerprint, method: METHOD };
}
export async function verifySourceTrace(root, trace) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace) || trace.format !== FORMAT ||
    !/^[0-9a-f]{40}$/.test(trace.gitCommit) || typeof trace.dirty !== 'boolean' || trace.method !== METHOD || !Array.isArray(trace.files)) throw new Error('INVALID_SOURCE_TRACE');
  const actual = await fingerprintSources(root);
  for (const key of ['sourceSha256', 'sourceFileCount', 'coreSha256', 'coreFileCount']) if (trace[key] !== actual[key]) throw new Error('SOURCE_TRACE_MISMATCH');
  if (trace.files.length !== actual.files.length || actual.files.some((file, index) => {
    const claimed = trace.files[index]; return !claimed || claimed.path !== file.path || claimed.sha256 !== file.sha256 || claimed.bytes !== file.bytes;
  })) throw new Error('SOURCE_FILE_HASH_MISMATCH');
  return { format: FORMAT, gitCommit: trace.gitCommit, dirty: trace.dirty, ...actual, method: METHOD };
}
export function traceSummary(trace, verified = false) {
  return { format: trace.format, gitCommit: trace.gitCommit, dirty: trace.dirty, sourceSha256: trace.sourceSha256,
    sourceFileCount: trace.sourceFileCount, coreSha256: trace.coreSha256, coreFileCount: trace.coreFileCount,
    method: trace.method, providedTraceVerified: verified };
}
export async function sourceIdentity(root, tracePath) {
  if (!tracePath) return traceSummary(await createSourceTrace(root));
  const trace = await verifySourceTrace(root, JSON.parse(await readFile(tracePath, 'utf8')));
  return traceSummary(trace, true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
    const root = resolve(argument('--root') ?? fileURLToPath(new URL('../../../', import.meta.url)));
    const output = argument('--output'); if (!output) throw new Error('SOURCE_OUTPUT_REQUIRED');
    const trace = await createSourceTrace(root);
    await writeFile(output, JSON.stringify(trace, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify(traceSummary(trace)));
  } catch (error) {
    const codes = new Set(['SOURCE_DIRECTORY_REQUIRED', 'SOURCE_FILE_REQUIRED', 'SOURCE_SYMLINK_OR_SPECIAL_FILE',
      'SOURCE_DUPLICATE_PATH', 'INVALID_SOURCE_REVISION', 'SOURCE_OUTPUT_REQUIRED']);
    console.error(JSON.stringify({ stage: 'source-trace', code: codes.has(error.message) ? error.message : 'SOURCE_TRACE_FAILED' })); process.exitCode = 1;
  }
}
