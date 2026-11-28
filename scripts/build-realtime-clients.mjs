import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realtimeRegistrations } from '../packages/game-registry/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const game of realtimeRegistrations()) {
  const result = spawnSync('npm', ['run', 'build', '--workspace', game.realtime.workspace], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const destination = resolve(root, 'apps/portal/dist', '.' + game.realtime.route);
  await mkdir(destination, { recursive: true });
  await cp(resolve(root, game.realtime.source, 'dist'), destination, { recursive: true });
  const index = await readFile(resolve(destination, 'index.html'));
  await writeFile(resolve(destination, 'build.json'), JSON.stringify({ gameId: game.gameId, protocolVersion: game.realtime.protocolVersion, indexSha256: createHash('sha256').update(index).digest('hex') }) + '\n');
  process.stdout.write(`Composed ${game.gameId} client at ${game.realtime.route}\n`);
}
