import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const [command, source] of [[process.execPath, '../assets-source/generate-models.mjs'], ['python3', '../assets-source/generate-media.py']]) {
  const result = spawnSync(command, [fileURLToPath(new URL(source, import.meta.url))], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
