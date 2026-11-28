import manifest from '../games.json' with { type: 'json' };

export interface ChessRegistration {
  workspace: string;
  source: string;
  route: string;
  developmentUrl: string;
  health?: { path: string; protocol: string; rulesVersion: string };
  database?: { file: string; environment: string };
}
export interface GameRegistration {
  gameId: string;
  collectionId: 'chess' | 'other';
  title: { ru: string; en: string };
  description: { ru: string; en: string };
  minPlayers: number;
  maxPlayers: number;
  /** Guest launch and platform-account rooms are independent capabilities. */
  roomStatus: 'planned' | 'unavailable' | 'runtime';
  chess?: ChessRegistration;
  realtime?: { workspace: string; source: string; route: string; developmentUrl: string; protocolVersion: 1; healthPath: string; roomLaunch: 'platform' };
}
export interface Registry { version: 1 | 2; chessOrigin: string; games: GameRegistration[] }

function objectFields(value: unknown, allowed: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label} fields`);
}
function validUrl(value: string) { try { return new URL(value); } catch { return null; } }
/** Fail closed on ambiguous routes, duplicate runtime resources or unsafe path fields. */
export function validateRegistry(input: unknown): Registry {
  objectFields(input, ['version', 'chessOrigin', 'games'], 'game registry');
  const value = input as Registry;
  const origin = typeof value.chessOrigin === 'string' ? validUrl(value.chessOrigin) : null;
  if (![1, 2].includes(value.version) || !Array.isArray(value.games) || !origin || origin.protocol !== 'https:' || origin.origin !== value.chessOrigin) throw new Error('Invalid game registry version/origin');
  const ids = new Set<string>(), routes = new Set<string>(), sources = new Set<string>(), workspaces = new Set<string>();
  const healthPaths = new Set<string>(), databaseFiles = new Set<string>(), databaseEnvs = new Set<string>();
  for (const game of value.games) {
    objectFields(game, ['gameId', 'collectionId', 'title', 'description', 'minPlayers', 'maxPlayers', 'roomStatus', 'chess', ...(value.version === 2 ? ['realtime'] : [])], 'game');
    if (typeof game.gameId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(game.gameId) || ids.has(game.gameId)) throw new Error('Invalid/duplicate game ID');
    ids.add(game.gameId);
    if (!['chess', 'other'].includes(game.collectionId) || !['planned', 'unavailable', 'runtime'].includes(game.roomStatus)) throw new Error(`Invalid game capabilities: ${game.gameId}`);
    for (const field of ['title', 'description'] as const) {
      objectFields(game[field], ['ru', 'en'], field);
      for (const lang of ['ru', 'en'] as const) if (typeof game[field][lang] !== 'string' || !game[field][lang].trim()) throw new Error(`Missing ${field}/${lang}: ${game.gameId}`);
    }
    if (![game.minPlayers, game.maxPlayers].every(Number.isSafeInteger) || game.minPlayers < 1 || game.maxPlayers < game.minPlayers || game.maxPlayers > 64) throw new Error(`Invalid player limits: ${game.gameId}`);
    const realtime = game.realtime;
    if (realtime !== undefined) {
      objectFields(realtime, ['workspace', 'source', 'route', 'developmentUrl', 'protocolVersion', 'healthPath', 'roomLaunch'], 'realtime');
      if (game.chess || game.collectionId !== 'other' || !/^@iva-games\/[a-z][a-z0-9-]*$/.test(realtime.workspace) ||
        !/^games\/[a-z][a-z0-9-]*$/.test(realtime.source) || !/^\/play\/[a-z][a-z0-9-]*\/$/.test(realtime.route) ||
        realtime.protocolVersion !== 1 || realtime.healthPath !== '/api/realtime/v1/health' || realtime.roomLaunch !== 'platform' ||
        routes.has(realtime.route) || sources.has(realtime.source) || workspaces.has(realtime.workspace) ||
        !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/play\/[a-z][a-z0-9-]*\/$/.test(realtime.developmentUrl)) throw new Error(`Invalid/duplicate realtime registration: ${game.gameId}`);
      routes.add(realtime.route); sources.add(realtime.source); workspaces.add(realtime.workspace);
    }
    const chess = game.chess;
    if (chess === undefined) continue;
    objectFields(chess, ['workspace', 'source', 'route', 'developmentUrl', 'health', 'database'], 'chess');
    if (game.collectionId !== 'chess' || !/^@chess-2\/[a-z][a-z0-9-]*$/.test(chess.workspace) || !/^games\/chess\/[a-z][a-z0-9-]*$/.test(chess.source) || workspaces.has(chess.workspace)) throw new Error(`Invalid/duplicate chess workspace: ${game.gameId}`);
    if (!/^\/(?:[a-z][a-z0-9-]*\/)?$/.test(chess.route) || ['/api/', '/assets/', '/ws/'].includes(chess.route) || routes.has(chess.route) || sources.has(chess.source)) throw new Error(`Invalid/duplicate chess route/source: ${game.gameId}`);
    routes.add(chess.route); sources.add(chess.source); workspaces.add(chess.workspace);
    if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/(?:[a-z0-9-]+\/)?$/.test(chess.developmentUrl) || !validUrl(chess.developmentUrl)) throw new Error(`Invalid development URL: ${game.gameId}`);
    if (chess.health !== undefined) {
      objectFields(chess.health, ['path', 'protocol', 'rulesVersion'], 'health');
      if (!/^\/api\/(?:[a-z0-9-]+\/)?health$/.test(chess.health.path) || healthPaths.has(chess.health.path) || typeof chess.health.protocol !== 'string' || typeof chess.health.rulesVersion !== 'string' || !/^[a-z][a-z0-9.-]*$/.test(chess.health.protocol) || !/^[a-z][a-z0-9.-]*$/.test(chess.health.rulesVersion)) throw new Error(`Invalid/duplicate health contract: ${game.gameId}`);
      healthPaths.add(chess.health.path);
    }
    if (chess.database !== undefined) {
      objectFields(chess.database, ['file', 'environment'], 'database');
      if (!/^[a-z][a-z0-9-]*\.sqlite$/.test(chess.database.file) || !/^[A-Z][A-Z0-9_]*_PATH$/.test(chess.database.environment) || databaseFiles.has(chess.database.file) || databaseEnvs.has(chess.database.environment)) throw new Error(`Invalid/duplicate database contract: ${game.gameId}`);
      databaseFiles.add(chess.database.file); databaseEnvs.add(chess.database.environment);
    }
  }
  if (routes.has('/')) throw new Error('The chess collection root is reserved for the catalogue');
  return value;
}
export const gameRegistry = validateRegistry(manifest);
export function chessRegistrations(registry: Registry = gameRegistry) {
  return registry.games.filter((game): game is GameRegistration & { chess: ChessRegistration } => !!game.chess);
}
export const chessGames = chessRegistrations();
export function registration(gameId: string) { return gameRegistry.games.find(game => game.gameId === gameId); }
export function launchUrls(options: { development?: boolean; overrides?: Record<string, unknown>; registry?: Registry } = {}): Record<string, string> {
  const registry = options.registry ?? gameRegistry;
  return Object.fromEntries(registry.games.filter(game => !!game.chess || !!game.realtime).map(game => {
    const override = options.overrides?.['VITE_' + game.gameId.toUpperCase().replaceAll('-', '_') + '_URL'];
    const url = typeof override === 'string' && /^https?:\/\//.test(override) ? override : game.realtime
      ? options.development ? game.realtime.developmentUrl : game.realtime.route
      : options.development ? game.chess!.developmentUrl : registry.chessOrigin + game.chess!.route;
    return [game.gameId, url];
  }));
}
export function chessEntryForPath(pathname: string, registry: Registry = gameRegistry): string {
  const match = registry.games.filter(game => game.chess && game.chess.route !== '/')
    .find(game => pathname === game.chess!.route.slice(0, -1) || pathname.startsWith(game.chess!.route));
  return (match ? match.chess!.route.slice(1) : '') + 'index.html';
}
export function catalogueDefaults(registry: Registry = gameRegistry) {
  return registry.games.filter(game => game.roomStatus !== 'runtime').map(game => ({
    gameId: game.gameId, title: game.title.ru, collectionId: game.collectionId,
    minPlayers: game.minPlayers, maxPlayers: game.maxPlayers, supportsBots: false,
    rulesVersion: 'pending', contentVersion: 'pending', status: game.roomStatus as 'planned' | 'unavailable',
  }));
}
