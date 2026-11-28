import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogueDefaults, chessEntryForPath, chessRegistrations, gameRegistry, launchUrls, validateRegistry } from '../src/index';
import type { Registry } from '../src/index';

function future(): Registry {
  const registry = structuredClone(gameRegistry);
  registry.games.push({ gameId: 'future-chess', collectionId: 'chess', title: { ru: 'Новая игра', en: 'Future chess' },
    description: { ru: 'Тестовая регистрация', en: 'Fixture registration' }, minPlayers: 1, maxPlayers: 2, roomStatus: 'unavailable',
    chess: { workspace: '@chess-2/future-chess', source: 'games/chess/future-chess', route: '/future-chess/', developmentUrl: 'http://127.0.0.1:5295/' } });
  return validateRegistry(registry);
}

describe('declarative game registration', () => {
  it('adds the catalogue, localization, guest link, build workspace and SPA route from one entry', () => {
    const registry = future();
    expect(catalogueDefaults(registry).find(game => game.gameId === 'future-chess')).toMatchObject({ title: 'Новая игра', status: 'unavailable', minPlayers: 1 });
    expect(launchUrls({ registry })['future-chess']).toBe('https://chess.iva-games.pro/future-chess/');
    expect(launchUrls({ registry, development: true })['future-chess']).toBe('http://127.0.0.1:5295/');
    expect(launchUrls({ registry, overrides: { VITE_FUTURE_CHESS_URL: 'https://preview.invalid/future/' } })['future-chess']).toBe('https://preview.invalid/future/');
    expect(chessRegistrations(registry).at(-1)?.chess.workspace).toBe('@chess-2/future-chess');
    expect(chessEntryForPath('/future-chess', registry)).toBe('future-chess/index.html');
    expect(chessEntryForPath('/future-chess/resume', registry)).toBe('future-chess/index.html');
    expect(chessEntryForPath('/future-chess-impostor', registry)).toBe('index.html');
  });
  it('keeps the known game routes and independent room capabilities', () => {
    expect(launchUrls().remorse).toBe('https://chess.iva-games.pro/remorse/');
    expect(chessEntryForPath('/')).toBe('index.html');
    expect(chessEntryForPath('/remorse/')).toBe('remorse/index.html');
    expect(chessEntryForPath('/overdrive/')).toBe('overdrive/index.html');
    expect(chessEntryForPath('/colossus/')).toBe('colossus/index.html');
    expect(catalogueDefaults().find(game => game.gameId === 'colossus')?.status).toBe('unavailable');
    expect(catalogueDefaults().some(game => game.gameId === 'platform-lab')).toBe(false);
    expect(launchUrls().forpost).toBe('/play/forpost/');
    expect(launchUrls({ development: true }).forpost).toBe('http://127.0.0.1:4274/play/forpost/');
    expect(gameRegistry.games.find(game => game.gameId === 'forpost')).toMatchObject({ minPlayers: 2, maxPlayers: 6, roomStatus: 'runtime' });
  });
  it('keeps legacy registries readable and validates the independent realtime route contract', () => {
    const legacy = structuredClone(gameRegistry); legacy.version = 1; legacy.games = legacy.games.filter(game => !game.realtime);
    expect(validateRegistry(legacy).version).toBe(1);
    for (const patch of [{ protocolVersion: 2 }, { route: '/api/' }, { source: '../outside' }, { developmentUrl: 'javascript:alert(1)' }, { roomLaunch: 'direct' }]) {
      const current = structuredClone(gameRegistry), entry = current.games.find(game => game.gameId === 'forpost')!;
      Object.assign(entry.realtime!, patch); expect(() => validateRegistry(current)).toThrow();
    }
    const mixed = structuredClone(gameRegistry), entry = mixed.games.find(game => game.gameId === 'forpost')!;
    entry.chess = structuredClone(mixed.games.find(game => game.gameId === 'colossus')!.chess);
    expect(() => validateRegistry(mixed)).toThrow();
  });
  it.each(['route', 'source', 'gameId', 'traversal', 'protocol'] as const)('rejects %s collisions or unsafe manifest values', kind => {
    const registry = future();
    const entry = registry.games.at(-1)!;
    if (kind === 'route') entry.chess!.route = '/colossus/';
    if (kind === 'source') entry.chess!.source = 'games/chess/colossus';
    if (kind === 'gameId') entry.gameId = 'colossus';
    if (kind === 'traversal') entry.chess!.route = '/../';
    if (kind === 'protocol') entry.chess!.developmentUrl = 'javascript:alert(1)';
    expect(() => validateRegistry(registry)).toThrow();
  });
  it.each(['workspace', 'health', 'database-file', 'database-env', 'reserved-route', 'root-game', 'invalid-port', 'unknown-field', 'missing-protocol'] as const)('rejects invalid %s declarations before build/deploy', kind => {
    const registry = future();
    const entry = registry.games.at(-1)!;
    if (kind === 'workspace') entry.chess!.workspace = '@chess-2/colossus';
    if (kind === 'health') entry.chess!.health = structuredClone(registry.games.find(game => game.gameId === 'colossus')!.chess!.health!);
    if (kind === 'database-file') entry.chess!.database = { file: 'colossus.sqlite', environment: 'FUTURE_DATABASE_PATH' };
    if (kind === 'database-env') entry.chess!.database = { file: 'future-chess.sqlite', environment: 'COLOSSUS_DATABASE_PATH' };
    if (kind === 'reserved-route') entry.chess!.route = '/api/';
    if (kind === 'root-game') entry.chess!.route = '/';
    if (kind === 'invalid-port') entry.chess!.developmentUrl = 'http://127.0.0.1:999999/';
    if (kind === 'missing-protocol') Object.assign(entry.chess!, { health: { path: '/api/future-chess/health', rulesVersion: 'future-v1' } });
    if (kind === 'unknown-field') Object.assign(entry.chess!, { command: 'run-anything' });
    expect(() => validateRegistry(registry)).toThrow();
  });
  it('composes a fourth static client using its declared route without a script edit', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const temporary = await mkdtemp(join(tmpdir(), 'iva-registry-'));
    try {
      await mkdir(join(temporary, 'scripts'), { recursive: true });
      await mkdir(join(temporary, 'packages/game-registry/src'), { recursive: true });
      await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
      await copyFile(join(root, 'scripts/compose-client.mjs'), join(temporary, 'scripts/compose-client.mjs'));
      await copyFile(join(root, 'packages/game-registry/src/index.ts'), join(temporary, 'packages/game-registry/src/index.ts'));
      await writeFile(join(temporary, 'packages/game-registry/games.json'), JSON.stringify(future()));
      await mkdir(join(temporary, 'apps/portal/chess-home/dist'), { recursive: true });
      await writeFile(join(temporary, 'apps/portal/chess-home/dist/index.html'), '<title>Chess catalogue</title>');
      for (const game of chessRegistrations(future())) {
        const directory = join(temporary, game.chess.source, 'dist');
        await mkdir(join(directory, 'assets'), { recursive: true });
        await writeFile(join(directory, 'index.html'), `<title>${game.gameId}</title>`);
        await writeFile(join(directory, 'assets', game.gameId + '.js'), `/* ${game.gameId} */`);
      }
      await promisify(execFile)(process.execPath, ['--experimental-strip-types', join(temporary, 'scripts/compose-client.mjs')]);
      expect(await readFile(join(temporary, 'dist/future-chess/index.html'), 'utf8')).toBe('<title>future-chess</title>');
      expect(await readFile(join(temporary, 'dist/assets/future-chess.js'), 'utf8')).toBe('/* future-chess */');
      expect(await readFile(join(temporary, 'dist/index.html'), 'utf8')).toBe('<title>Chess catalogue</title>');
      expect(await readFile(join(temporary, 'dist/remorse/index.html'), 'utf8')).toBe('<title>remorse</title>');
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});
