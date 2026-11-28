import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RealtimeStore } from '../src/store';
import { retainedClientDirectory } from '../src/content';
import { checkStoreCompatibility, compatibilityInventory, readStoreManifests, sealRetentionBundle, SUPPORTED_READERS, verifyCurrentBundle, verifyRetentionBundle } from '../src/retention';
import type { RetentionBundle, SavedManifest } from '../src/retention';

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'iva-retention-')); temporary.push(root);
  return { root, revision: (version: number) => String(version).repeat(40), source(version: number) {
    const directory = join(root, `runtime-${version}`); mkdirSync(join(directory, 'assets'), { recursive: true });
    for (const name of ['main.js', 'store-worker.js', 'simulation-worker.js', 'checkpoint-worker.js', 'retention-cli.js', 'assets/core.js']) writeFileSync(join(directory, name), `// explicit archive fixture ${version}: ${name}\n`);
    const client = join(root, `client-${version}`); mkdirSync(join(client, 'assets'), { recursive: true });
    writeFileSync(join(client, 'index.html'), '<script src="./assets/game.js"></script>'); writeFileSync(join(client, 'assets/game.js'), `// explicit client fixture ${version}\n`);
    return { directory, url: pathToFileURL(directory + '/'), client };
  } };
}
function manifest(bundle: RetentionBundle): SavedManifest {
  return { runtime: bundle.current.runtime, ...SUPPORTED_READERS.profiles[0].accepts, client: bundle.current.client };
}
function seal(f: ReturnType<typeof fixture>, version: number, previous?: { bundle: RetentionBundle; root: string; required: SavedManifest[] }) {
  const input = join(f.root, `input-${version}`); mkdirSync(input);
  if (previous) {
    cpSync(previous.root, join(input, 'bundle'), { recursive: true });
    writeFileSync(join(input, 'input.json'), JSON.stringify({ format: 1, bootstrap: false,
      inventory: compatibilityInventory(previous.required, previous.bundle.buildRevision, previous.bundle.current.runtime, previous.bundle.current.client),
      image: { repository: 'ghcr.io/decorum-guy/iva-games-realtime', revision: previous.bundle.buildRevision, digest: 'sha256:' + 'a'.repeat(64) } }));
  } else writeFileSync(join(input, 'input.json'), JSON.stringify({ format: 1, bootstrap: true, inventory: null, image: null }));
  const source = f.source(version), output = join(f.root, `bundle-${version}`);
  const bundle = sealRetentionBundle({ inputDirectory: input, outputDirectory: output, runtimeSource: source.url, clientSource: source.client, buildRevision: f.revision(version) });
  return { root: output, bundle, source, input };
}
function put(store: RealtimeStore, id: string, saved: SavedManifest, phase = 'paused', expiry = Date.now() + 60000) {
  store.db.prepare('INSERT INTO rt_matches(match_id,start_id,fingerprint,record_json,world_hash,owner_epoch,lease_owner,lease_until,journal_seq,expires_at,phase) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, id, 'fixture-fingerprint', JSON.stringify({ manifest: saved, matchId: id, roster: [{ playerId: 'private-person' }], world: 'private-world' }), 'fixture-world-hash', 1, 'fixture-owner', 0, 0, expiry, phase);
}

describe('release retention against actual saved versions', () => {
  it('publishes only unique manifest metadata from the actual store, including resumable and expired active records', () => {
    const f = fixture(), first = seal(f, 1), store = new RealtimeStore(join(f.root, 'actual.sqlite'));
    try {
      put(store, 'private-match-one', manifest(first.bundle)); put(store, 'private-match-two', manifest(first.bundle), 'battle', 1);
      put(store, 'finished-expired', { ...manifest(first.bundle), runtime: 'sha256:' + 'b'.repeat(64) }, 'finished', 1);
      const inventory = compatibilityInventory(store.compatibilityManifests(), f.revision(1), first.bundle.current.runtime, first.bundle.current.client);
      expect(inventory.manifests).toEqual([manifest(first.bundle)]);
      expect(Object.keys(inventory)).toEqual(['format', 'buildRevision', 'current', 'manifests']);
      expect(JSON.stringify(inventory)).not.toMatch(/private-|"(?:roster|world|ownerHash|matchId)"/);
      expect(() => compatibilityInventory([{ ...manifest(first.bundle), world: 'secret' }], f.revision(1), first.bundle.current.runtime, first.bundle.current.client)).toThrow('INVALID_SAVED_MANIFEST');
    } finally { store.close(); }
  });

  it('carries the previous current and recursive archives into release three, and rejects an unsafe rollback', () => {
    const f = fixture(), first = seal(f, 1), second = seal(f, 2, { ...first, required: [manifest(first.bundle)] });
    // Only the oldest version remains in the store inventory; release two's
    // current bundle must still be carried so a racing new room is covered.
    const third = seal(f, 3, { ...second, required: [manifest(first.bundle)] });
    expect(third.bundle.artifacts).toHaveLength(3); expect(third.bundle.clients).toHaveLength(3);
    expect(third.bundle.artifacts).toContain(first.bundle.current.runtime); expect(third.bundle.artifacts).toContain(second.bundle.current.runtime);
    const path = join(f.root, 'actual.sqlite'), store = new RealtimeStore(path);
    try {
      put(store, 'oldest', manifest(first.bundle)); put(store, 'newest', manifest(third.bundle));
      const before = readFileSync(path), walBefore = readFileSync(path + '-wal');
      expect(checkStoreCompatibility(path, verifyRetentionBundle(third.root)).manifests).toBe(2);
      expect(readFileSync(path)).toEqual(before); expect(readFileSync(path + '-wal')).toEqual(walBefore);
      expect(() => checkStoreCompatibility(path, verifyRetentionBundle(second.root))).toThrow('MISSING_SAVED_ARTIFACT');
    } finally { store.close(); }
  });

  it('does not let a bootstrap HTTP404 input bypass the final actual-store check', () => {
    const f = fixture(), first = seal(f, 1), emptyBuildInput = seal(f, 2), path = join(f.root, 'actual.sqlite'), store = new RealtimeStore(path);
    try {
      put(store, 'still-resumable', manifest(first.bundle));
      expect(() => checkStoreCompatibility(path, emptyBuildInput.bundle, true)).toThrow('MISSING_SAVED_ARTIFACT');
    } finally { store.close(); }
    const empty = join(f.root, 'new-volume'); mkdirSync(empty);
    expect(() => readStoreManifests(join(empty, 'realtime.sqlite'))).toThrow('REALTIME_STORE_MISSING');
    expect(readStoreManifests(join(empty, 'realtime.sqlite'), { allowEmptyStore: true })).toEqual([]);
    writeFileSync(join(empty, 'realtime.sqlite-wal'), 'orphaned data');
    expect(() => readStoreManifests(join(empty, 'realtime.sqlite'), { allowEmptyStore: true })).toThrow('REALTIME_STORE_MISSING');
  });

  it('requires an explicit supported reader even when exact executable and client bytes exist', () => {
    const f = fixture(), first = seal(f, 1), path = join(f.root, 'actual.sqlite'), store = new RealtimeStore(path);
    try {
      put(store, 'future-format', { ...manifest(first.bundle), serializer: 'forpost-world-2' });
      expect(() => checkStoreCompatibility(path, first.bundle)).toThrow('UNSUPPORTED_SAVED_READER');
      store.db.prepare('DELETE FROM rt_matches').run(); store.db.pragma('user_version = 2');
      expect(() => checkStoreCompatibility(path, first.bundle)).toThrow('UNSUPPORTED_STORE_READER');
    } finally { store.close(); }
  });

  it('rechecks bytes despite an earlier HTTP content cache, and verifies the current image sources', () => {
    const f = fixture(), first = seal(f, 1);
    const directory = retainedClientDirectory(join(first.root, 'content'), first.bundle.current.client);
    writeFileSync(join(directory, 'assets/game.js'), '// altered after the cache was populated');
    expect(() => verifyRetentionBundle(first.root)).toThrow('INVALID_CLIENT_CONTENT');
    const second = seal(f, 2);
    writeFileSync(join(second.source.directory, 'checkpoint-worker.js'), '// changed current entry');
    expect(() => verifyCurrentBundle(second.root, second.source.url, second.source.client, f.revision(2))).toThrow('CURRENT_BUNDLE_MISMATCH');
  });

  it('rejects a tampered seal or an inventory taken from a different image revision', () => {
    const f = fixture(), first = seal(f, 1), second = seal(f, 2, { ...first, required: [manifest(first.bundle)] });
    const metadata = JSON.parse(readFileSync(join(second.root, 'bundle.json'), 'utf8'));
    metadata.current = first.bundle.current; writeFileSync(join(second.root, 'bundle.json'), JSON.stringify(metadata));
    expect(() => verifyRetentionBundle(second.root)).toThrow('INVALID_RETENTION_BUNDLE');
    const input = JSON.parse(readFileSync(join(second.input, 'input.json'), 'utf8'));
    input.inventory.buildRevision = f.revision(3); input.image.revision = f.revision(3);
    writeFileSync(join(second.input, 'input.json'), JSON.stringify(input));
    expect(() => sealRetentionBundle({ inputDirectory: second.input, outputDirectory: join(f.root, 'mismatched'), runtimeSource: second.source.url,
      clientSource: second.source.client, buildRevision: f.revision(2) })).toThrow('RETENTION_SOURCE_MISMATCH');
  });
});
