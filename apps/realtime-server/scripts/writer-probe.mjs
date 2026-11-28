/** Short actual-SQLite comparison. This is not browser or capacity acceptance. */
import { build } from 'vite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, sourceIdentity } from './probe-lib.mjs';

await mkdir(resolve(root, '.qa'), { recursive: true });
const directory = await mkdtemp(resolve(root, '.qa/writer-checkpoint-'));
const source = await sourceIdentity();
await build({ configFile: false, logLevel: 'warn', root, build: { ssr: true, outDir: resolve(directory, 'code'), target: 'node24',
  rollupOptions: { input: { 'writer-case': resolve(root, 'apps/realtime-server/scripts/writer-probe-case.ts'),
    'checkpoint-worker': resolve(root, 'apps/realtime-server/src/checkpoint-worker.ts') }, output: { entryFileNames: '[name].js' } } },
  ssr: { noExternal: ['@iva-games/forpost', '@iva-games/realtime-kit', '@iva-games/session-kit'], external: ['better-sqlite3', 'ws'] } });
const files = async (prefix = '') => {
  const result = [];
  for (const entry of await readdir(resolve(directory, 'code', prefix), { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) result.push(...await files(path + '/')); else if (entry.isFile()) result.push(path);
  }
  return result.sort();
};
const executable = createHash('sha256');
for (const path of await files()) { executable.update(path); executable.update(await readFile(resolve(directory, 'code', path))); }
await writeFile(resolve(directory, 'source.json'), JSON.stringify({ ...source, probeExecutableSha256: executable.digest('hex') }, null, 2));
const child = spawn(process.execPath, [resolve(directory, 'code/writer-case.js'), directory], { cwd: root, stdio: 'inherit' });
const [code] = await once(child, 'exit');
console.log(JSON.stringify({ directory, exitCode: code, kind: 'actual SQLite diagnostic, not browser or capacity acceptance' }));
process.exitCode = code ?? 1;
