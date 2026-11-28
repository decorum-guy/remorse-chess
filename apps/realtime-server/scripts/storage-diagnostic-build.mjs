/** Invoked only by storage-diagnostic.mjs in its new private checkout directory. */
import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

process.umask(0o077);
const root = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
const run = await realpath(process.argv[2]);
assert.match(relative(root, run), /^\.qa\/storage-[A-Za-z0-9_-]+$/);
assert.equal((await lstat(run)).isDirectory(), true);
await build({ configFile: false, logLevel: 'silent', root, build: { ssr: true, outDir: resolve(run, 'raw/code'), target: 'node24',
  rollupOptions: { input: { 'storage-case': resolve(root, 'apps/realtime-server/scripts/storage-diagnostic-case.ts'),
    'checkpoint-worker': resolve(root, 'apps/realtime-server/src/checkpoint-worker.ts') }, output: { entryFileNames: '[name].js' } } },
  ssr: { noExternal: ['@iva-games/forpost', '@iva-games/realtime-kit', '@iva-games/session-kit'], external: ['better-sqlite3', 'ws'] } });
