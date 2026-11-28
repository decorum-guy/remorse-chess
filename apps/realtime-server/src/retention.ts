/** Release compatibility is checked against actual saved manifests, never N−1. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { CONTENT_ID, copyRuntimeArtifact, retainRuntimeArtifact, runtimeArtifactManifest, verifyRuntimeArtifact } from './artifacts.js';
import { clientContentManifest, copyClientContent, retainClientContent, verifyClientContent } from './content.js';

const REVISION = /^[0-9a-f]{40}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,159}$/;
export const MANIFEST_FIELDS = ['runtime', 'rules', 'content', 'protocol', 'serializer', 'bot', 'map', 'physics', 'prng', 'client'] as const;
export type SavedManifest = Record<typeof MANIFEST_FIELDS[number], string>;
export interface ReaderProfile { id: string; accepts: Omit<SavedManifest, 'runtime' | 'client'> }
export interface ReaderRegistry { format: 1; store: { id: string; userVersions: number[] }; profiles: ReaderProfile[] }
export const SUPPORTED_READERS: ReaderRegistry = {
  format: 1, store: { id: 'realtime-sqlite-record-1', userVersions: [0] },
  profiles: [{ id: 'forpost-world-1', accepts: { rules: 'forpost-0.1', content: 'forpost-content-1', protocol: '1', serializer: 'forpost-world-1',
    bot: 'forpost-bot-0.1', map: 'forpost-maps-0.1', physics: 'forpost-kinematic-1', prng: 'xorshift32-1' } }],
};
export interface CompatibilityInventory {
  format: 1; buildRevision: string; current: { runtime: string; client: string }; manifests: SavedManifest[];
}
export interface RetentionBundle {
  format: 1; buildRevision: string; current: { runtime: string; client: string };
  artifacts: string[]; clients: string[]; readers: ReaderRegistry; seal: string;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)); }
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
export function stableJSON(value: unknown): string { return JSON.stringify(sorted(value)); }
function checksum(value: unknown): string { return 'sha256:' + createHash('sha256').update(stableJSON(value)).digest('hex'); }
function jsonFile(path: string): unknown {
  if (!lstatSync(path).isFile() || lstatSync(path).size > 16 * 1024 * 1024) throw new Error('INVALID_RETENTION_BUNDLE');
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}
export function savedManifest(value: unknown): SavedManifest {
  if (!object(value) || !keys(value, MANIFEST_FIELDS)) throw new Error('INVALID_SAVED_MANIFEST');
  const result = {} as SavedManifest;
  for (const field of MANIFEST_FIELDS) {
    const item = value[field];
    if (typeof item !== 'string' || !(field === 'runtime' || field === 'client' ? CONTENT_ID : VERSION).test(item)) throw new Error('INVALID_SAVED_MANIFEST');
    result[field] = item;
  }
  return result;
}
function manifests(values: unknown): SavedManifest[] {
  if (!Array.isArray(values) || values.length > 4096) throw new Error('INVALID_COMPATIBILITY_INVENTORY');
  const unique = new Map<string, SavedManifest>();
  for (const value of values) { const manifest = savedManifest(value); unique.set(stableJSON(manifest), manifest); }
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, manifest]) => manifest);
}
function current(value: unknown): { runtime: string; client: string } {
  if (!object(value) || !keys(value, ['runtime', 'client']) || typeof value.runtime !== 'string' || typeof value.client !== 'string' ||
    !CONTENT_ID.test(value.runtime) || !CONTENT_ID.test(value.client)) throw new Error('INVALID_COMPATIBILITY_INVENTORY');
  return { runtime: value.runtime, client: value.client };
}
export function compatibilityInventory(values: unknown, buildRevision: string, runtime: string, client: string): CompatibilityInventory {
  if (!REVISION.test(buildRevision)) throw new Error('INVALID_BUILD_REVISION');
  return { format: 1, buildRevision, current: current({ runtime, client }), manifests: manifests(values) };
}
export function parseCompatibilityInventory(value: unknown): CompatibilityInventory {
  if (!object(value) || !keys(value, ['format', 'buildRevision', 'current', 'manifests']) || value.format !== 1 || typeof value.buildRevision !== 'string') throw new Error('INVALID_COMPATIBILITY_INVENTORY');
  const ids = current(value.current);
  return compatibilityInventory(value.manifests, value.buildRevision, ids.runtime, ids.client);
}
function readers(value: unknown): ReaderRegistry {
  if (!object(value) || !keys(value, ['format', 'store', 'profiles']) || value.format !== 1 || !object(value.store) ||
    !keys(value.store, ['id', 'userVersions']) || typeof value.store.id !== 'string' || !VERSION.test(value.store.id) ||
    !Array.isArray(value.store.userVersions) || value.store.userVersions.length === 0 || value.store.userVersions.length > 64 ||
    value.store.userVersions.some(version => !Number.isSafeInteger(version) || version < 0) ||
    !Array.isArray(value.profiles) || value.profiles.length === 0 || value.profiles.length > 128) throw new Error('INVALID_READER_REGISTRY');
  const profiles = value.profiles.map(profile => {
    const fields = MANIFEST_FIELDS.filter(field => field !== 'runtime' && field !== 'client');
    if (!object(profile) || !keys(profile, ['id', 'accepts']) || typeof profile.id !== 'string' || !VERSION.test(profile.id) ||
      !object(profile.accepts) || !keys(profile.accepts, fields)) throw new Error('INVALID_READER_REGISTRY');
    const accepts = profile.accepts;
    if (fields.some(field => typeof accepts[field] !== 'string' || !VERSION.test(accepts[field] as string))) throw new Error('INVALID_READER_REGISTRY');
    return { id: profile.id, accepts: Object.fromEntries(fields.map(field => [field, accepts[field]])) as ReaderProfile['accepts'] };
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('INVALID_READER_REGISTRY');
  return { format: 1, store: { id: value.store.id, userVersions: [...new Set(value.store.userVersions as number[])].sort((a, b) => a - b) }, profiles };
}
export function assertSupportedManifest(manifest: SavedManifest, registry = SUPPORTED_READERS): void {
  if (!registry.profiles.some(profile => Object.entries(profile.accepts).every(([field, value]) => manifest[field as keyof SavedManifest] === value))) throw new Error('UNSUPPORTED_SAVED_READER');
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096 || value.some(id => typeof id !== 'string' || !CONTENT_ID.test(id)) ||
    new Set(value).size !== value.length || stableJSON(value) !== stableJSON([...value].sort())) throw new Error('INVALID_RETENTION_BUNDLE');
  return value as string[];
}
export function verifyRetentionBundle(root: string): RetentionBundle {
  if (!lstatSync(root).isDirectory()) throw new Error('INVALID_RETENTION_BUNDLE');
  const value = jsonFile(join(root, 'bundle.json'));
  if (!object(value) || !keys(value, ['format', 'buildRevision', 'current', 'artifacts', 'clients', 'readers', 'seal']) ||
    value.format !== 1 || typeof value.buildRevision !== 'string' || !REVISION.test(value.buildRevision) || typeof value.seal !== 'string') throw new Error('INVALID_RETENTION_BUNDLE');
  const body = { format: 1 as const, buildRevision: value.buildRevision, current: current(value.current), artifacts: ids(value.artifacts), clients: ids(value.clients), readers: readers(value.readers) };
  if (checksum(body) !== value.seal || !body.artifacts.includes(body.current.runtime) || !body.clients.includes(body.current.client)) throw new Error('INVALID_RETENTION_BUNDLE');
  for (const [name, entries] of [['artifacts', body.artifacts], ['content', body.clients]] as const) {
    const directory = join(root, name);
    if (!lstatSync(directory).isDirectory() || stableJSON(readdirSync(directory).sort()) !== stableJSON(entries.map(id => id.slice(7)).sort())) throw new Error('INVALID_RETENTION_BUNDLE');
  }
  for (const id of body.artifacts) verifyRuntimeArtifact(join(root, 'artifacts'), id);
  for (const id of body.clients) verifyClientContent(join(root, 'content'), id);
  if (stableJSON(readdirSync(root).sort()) !== stableJSON(['artifacts', 'bundle.json', 'content'])) throw new Error('INVALID_RETENTION_BUNDLE');
  return { ...body, seal: value.seal };
}
export function requireManifests(bundle: RetentionBundle, required: SavedManifest[]): void {
  for (const manifest of required) {
    assertSupportedManifest(manifest, bundle.readers);
    if (!bundle.artifacts.includes(manifest.runtime) || !bundle.clients.includes(manifest.client)) throw new Error('MISSING_SAVED_ARTIFACT');
  }
}
export function verifyCurrentBundle(root: string, runtimeSource: URL, clientSource: string, buildRevision: string): RetentionBundle {
  const bundle = verifyRetentionBundle(root);
  if (bundle.buildRevision !== buildRevision || stableJSON(bundle.readers) !== stableJSON(SUPPORTED_READERS) ||
    bundle.current.runtime !== runtimeArtifactManifest(runtimeSource).artifactId || bundle.current.client !== clientContentManifest(clientSource).contentId) throw new Error('CURRENT_BUNDLE_MISMATCH');
  return bundle;
}
export function sealRetentionBundle(options: { inputDirectory: string; outputDirectory: string; runtimeSource: URL; clientSource: string; buildRevision: string }): RetentionBundle {
  if (!REVISION.test(options.buildRevision)) throw new Error('INVALID_BUILD_REVISION');
  if (existsSync(options.outputDirectory)) throw new Error('RETENTION_OUTPUT_EXISTS');
  const input = jsonFile(join(options.inputDirectory, 'input.json'));
  if (!object(input) || !keys(input, ['format', 'bootstrap', 'inventory', 'image']) || input.format !== 1 || typeof input.bootstrap !== 'boolean') throw new Error('INVALID_RETENTION_INPUT');
  let previous: RetentionBundle | null = null, required: SavedManifest[] = [];
  if (input.bootstrap) {
    if (input.inventory !== null || input.image !== null || readdirSync(options.inputDirectory).some(name => name !== 'input.json')) throw new Error('INVALID_RETENTION_INPUT');
  } else {
    const inventory = parseCompatibilityInventory(input.inventory);
    if (!object(input.image) || !keys(input.image, ['repository', 'revision', 'digest']) || input.image.repository !== 'ghcr.io/decorum-guy/iva-games-realtime' ||
      input.image.revision !== inventory.buildRevision || typeof input.image.digest !== 'string' || !CONTENT_ID.test(input.image.digest)) throw new Error('INVALID_RETENTION_INPUT');
    previous = verifyRetentionBundle(join(options.inputDirectory, 'bundle'));
    if (previous.buildRevision !== inventory.buildRevision || stableJSON(previous.current) !== stableJSON(inventory.current)) throw new Error('RETENTION_SOURCE_MISMATCH');
    required = inventory.manifests; requireManifests(previous, required);
  }
  const sourceManifest = runtimeArtifactManifest(options.runtimeSource);
  if (!['checkpoint-worker.js', 'retention-cli.js'].every(file => sourceManifest.files.includes(file))) throw new Error('INCOMPLETE_CURRENT_RUNTIME');
  mkdirSync(options.outputDirectory, { recursive: true, mode: 0o755 });
  const artifactRoot = join(options.outputDirectory, 'artifacts'), clientRoot = join(options.outputDirectory, 'content');
  if (previous) {
    for (const id of previous.artifacts) copyRuntimeArtifact(join(options.inputDirectory, 'bundle/artifacts'), artifactRoot, id);
    for (const id of previous.clients) copyClientContent(join(options.inputDirectory, 'bundle/content'), clientRoot, id);
  }
  const runtime = retainRuntimeArtifact(options.runtimeSource, artifactRoot), client = retainClientContent(options.clientSource, clientRoot);
  const body = { format: 1 as const, buildRevision: options.buildRevision, current: { runtime: runtime.artifactId, client: client.contentId },
    artifacts: [...new Set([...(previous?.artifacts ?? []), runtime.artifactId])].sort(), clients: [...new Set([...(previous?.clients ?? []), client.contentId])].sort(), readers: readers(SUPPORTED_READERS) };
  requireManifests({ ...body, seal: checksum(body) }, required);
  writeFileSync(join(options.outputDirectory, 'bundle.json'), JSON.stringify({ ...body, seal: checksum(body) }, null, 2) + '\n', { mode: 0o644 });
  return verifyCurrentBundle(options.outputDirectory, options.runtimeSource, options.clientSource, options.buildRevision);
}

// Additive tables/columns are allowed, while these existing readers and layouts
// remain explicit. rt_start_queue is an additive table created by the writer.
const STORE_COLUMNS: Record<string, string[]> = {
  rt_matches: ['match_id', 'start_id', 'fingerprint', 'record_json', 'world_hash', 'owner_epoch', 'lease_owner', 'lease_until', 'journal_seq', 'expires_at', 'phase'],
  rt_journal: ['match_id', 'seq', 'tick', 'record_json', 'world_hash'], rt_checkpoints: ['match_id', 'seq', 'record_json', 'world_hash'],
  rt_actions: ['match_id', 'action_id', 'participant_id', 'payload_hash', 'record_json'], rt_tickets: ['ticket_id', 'expires_at'],
  rt_bridge_requests: ['request_id', 'expires_at'], rt_outbox: ['result_id', 'match_id', 'payload_json', 'delivered_at'],
  rt_admissions: ['admission_id', 'player_id', 'expires_at', 'revoked'],
};
export function readStoreManifests(databasePath: string, options: { allowEmptyStore?: boolean; now?: number; registry?: ReaderRegistry } = {}): SavedManifest[] {
  const path = resolve(databasePath), registry = options.registry ?? SUPPORTED_READERS;
  if (!existsSync(path)) {
    // A build-time HTTP 404 never supplies this permission. The host explicitly
    // enables it only for first provisioning and still mounts its actual volume.
    if (options.allowEmptyStore && lstatSync(dirname(path)).isDirectory() && readdirSync(dirname(path)).length === 0) return [];
    throw new Error('REALTIME_STORE_MISSING');
  }
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(path + suffix) && !lstatSync(path + suffix).isFile()) throw new Error('INVALID_REALTIME_STORE');
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 3000 });
  try {
    db.pragma('query_only = ON'); db.exec('BEGIN');
    if (registry.store.id !== 'realtime-sqlite-record-1' || !registry.store.userVersions.includes(Number(db.pragma('user_version', { simple: true }))) ||
      db.pragma('application_id', { simple: true }) !== 0 || db.pragma('quick_check(1)', { simple: true }) !== 'ok') throw new Error('UNSUPPORTED_STORE_READER');
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    for (const [table, required] of Object.entries(STORE_COLUMNS)) {
      if (!tables.has(table)) throw new Error('UNSUPPORTED_STORE_READER');
      const columns = new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map(row => row.name));
      if (required.some(name => !columns.has(name))) throw new Error('UNSUPPORTED_STORE_READER');
    }
    const rows = db.prepare("SELECT DISTINCT json_extract(record_json,'$.manifest') AS manifest FROM rt_matches WHERE expires_at>? OR phase NOT IN ('finished','abandoned')").all(options.now ?? Date.now()) as { manifest: string | null }[];
    const result = manifests(rows.map(row => row.manifest === null ? null : JSON.parse(row.manifest)));
    for (const manifest of result) assertSupportedManifest(manifest, registry);
    db.exec('COMMIT'); return result;
  } finally { db.close(); }
}
export function checkStoreCompatibility(databasePath: string, bundle: RetentionBundle, allowEmptyStore = false): { ok: true; manifests: number; bundleSeal: string; buildRevision: string } {
  const required = readStoreManifests(databasePath, { allowEmptyStore, registry: bundle.readers });
  requireManifests(bundle, required);
  return { ok: true, manifests: required.length, bundleSeal: bundle.seal, buildRevision: bundle.buildRevision };
}
