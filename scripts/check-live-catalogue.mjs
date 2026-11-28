/** Verify the public game's effective profile against this release's rules. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERRITORY_CONTENT, TERRITORY_RULES } from '../games/district/src/territorial/types.ts';

export const expectedDistrictProfile = Object.freeze({
  rulesVersion: TERRITORY_RULES,
  contentVersion: TERRITORY_CONTENT,
});

// Read the literal release identifiers without importing the game's runtime or
// its non-erasable TypeScript error classes into this dependency-free CLI.
const benchTypes = readFileSync(new URL('../games/test-bench/src/types.ts', import.meta.url), 'utf8');
function benchVersion(name) {
  const value = benchTypes.match(new RegExp(`export const ${name} = ['"]([^'"]+)['"];`))?.[1];
  assert.ok(value?.startsWith('test-bench'), `Missing Test Bench release identifier: ${name}`);
  return value;
}
export const expectedTestBenchProfile = Object.freeze({
  rulesVersion: benchVersion('RULES_VERSION'),
  contentVersion: benchVersion('CONTENT_VERSION'),
});

export async function checkLiveCatalogue(origin) {
  const base = new URL(origin);
  assert.ok(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password,
    'Use an HTTP(S) origin without credentials');
  const response = await fetch(new URL('/api/platform/v1/games', base), {
    signal: AbortSignal.timeout(10_000), redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  assert.equal(response.status, 200, 'The public catalogue must return HTTP 200');
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const { games } = await response.json();
  assert.ok(Array.isArray(games), 'The public catalogue must list games');
  const district = games.find(game => game.gameId === 'district');
  assert.ok(district, 'District must be registered');
  assert.equal(district.status, 'available', 'District must be available');
  assert.equal(district.supportsBots, true, 'District must support bots');
  assert.deepEqual({ rulesVersion: district.rulesVersion, contentVersion: district.contentVersion },
    expectedDistrictProfile, 'The public District profile must match the delivered release');
  const bench = games.find(game => game.gameId === 'test-bench');
  assert.ok(bench, 'Test Bench must be registered');
  assert.equal(bench.status, 'available', 'Test Bench must be available');
  assert.equal(bench.collectionId, 'other');
  assert.equal(bench.supportsBots, true, 'Test Bench must support explicit bot seats');
  assert.equal(bench.minPlayers, 2);
  assert.equal(bench.maxPlayers, 6);
  assert.deepEqual({ rulesVersion: bench.rulesVersion, contentVersion: bench.contentVersion },
    expectedTestBenchProfile, 'The public Test Bench profile must match the delivered release');
  return { origin: base.origin, games: [
    { gameId: 'district', ...expectedDistrictProfile },
    { gameId: 'test-bench', ...expectedTestBenchProfile },
  ] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.info(JSON.stringify({ catalogue: 'verified', ...await checkLiveCatalogue(process.argv[2] ?? 'https://iva-games.pro') }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
