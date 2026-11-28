import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { archiveCurrentClient, availableClientContents, readClientContent } from '../src/client-content.js';
import { createRealtimeHttpServer } from '../src/server.js';
import { LocalRuntimeClient } from '../src/rpc.js';
import { RealtimeEngine } from '../src/engine.js';
import { LocalStorageClient } from '../src/storage.js';
import { adapter, fixture, keyPair, request as startRequest } from './fixture.js';

const folders: string[] = [];
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });
const meta = { gameId: 'tyaga', route: '/play/tyaga/', rulesVersion: 'tyaga@0.1', contentVersion: 'tyaga-expedition@1' };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'iva-client-content-')); folders.push(directory);
  const source = join(directory, 'public'), archive = join(directory, 'archives');
  mkdirSync(join(source, 'assets'), { recursive: true });
  writeFileSync(join(source, 'index.html'), '<script type="module" src="./assets/client.js"></script>');
  writeFileSync(join(source, 'assets/client.js'), 'export const version=1;');
  writeFileSync(join(source, 'assets/model.glb'), 'glTF version one');
  return { directory, source, archive };
}
describe('retained browser content hashes', () => {
  it('keeps the complete earlier client when a deployment changes code and model bytes', () => {
    const f = setup(), first = archiveCurrentClient(f.source, f.archive, meta);
    writeFileSync(join(f.source, 'assets/client.js'), 'export const version=2;');
    writeFileSync(join(f.source, 'assets/model.glb'), 'glTF version two');
    const second = archiveCurrentClient(f.source, f.archive, meta);
    expect(second.sha256).not.toBe(first.sha256);
    expect(readFileSync(join(readClientContent(f.archive, first.sha256).directory, 'assets/model.glb'), 'utf8')).toBe('glTF version one');
    expect(availableClientContents(f.archive)).toHaveLength(2);
    expect(archiveCurrentClient(f.source, f.archive, meta).sha256).toBe(second.sha256);
  });
  it('rejects symlinks, nonlocal hashes, corrupted files and a client with absolute base paths', () => {
    const f = setup(), first = archiveCurrentClient(f.source, f.archive, meta);
    expect(() => readClientContent(f.archive, '../../outside')).toThrow('CLIENT_CONTENT_UNAVAILABLE');
    const model = join(first.directory, 'assets/model.glb'); chmodSync(model, 0o600); writeFileSync(model, 'corrupted');
    expect(() => readClientContent(f.archive, first.sha256)).toThrow('CLIENT_CONTENT_CORRUPT');
    expect(availableClientContents(f.archive)).toHaveLength(0);
    symlinkSync(join(f.source, 'index.html'), join(f.source, 'assets/link.html'));
    expect(() => archiveCurrentClient(f.source, f.archive, meta)).toThrow('CLIENT_CONTENT_INVALID');
    rmSync(join(f.source, 'assets/link.html'));
    writeFileSync(join(f.source, 'index.html'), '<script src="/play/tyaga/assets/current.js"></script>');
    expect(() => archiveCurrentClient(f.source, f.archive, meta)).toThrow('CLIENT_BASE_NOT_RELATIVE');
  });
  it('serves the exact archived entry and model over HTTP ahead of the current route prefix', async () => {
    const files = setup(), first = archiveCurrentClient(files.source, files.archive, meta);
    writeFileSync(join(files.source, 'assets/model.glb'), 'glTF current model');
    const f = await fixture(), keys = keyPair();
    const server = createRealtimeHttpServer({ runtime: new LocalRuntimeClient(f.engine), storage: f.storage,
      trustedKeys: new Map([['key', keys.publicKey]]), allowedHosts: ['content.test'], allowedOrigins: ['http://content.test'],
      staticDirectories: { '/play/tyaga/': files.source, [first.route]: first.directory } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
    const get = (path: string) => new Promise<{ status: number; body: string; type?: string; location?: string; cache?: string }>((resolve, reject) => {
      const call = request({ hostname: '127.0.0.1', port: address.port, path, headers: { Host: 'content.test' } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', bytes => { body += bytes; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body, type: response.headers['content-type'], location: response.headers.location, cache: response.headers['cache-control'] }));
      }); call.on('error', reject); call.end();
    });
    try {
      expect((await get(first.route)).body).toContain('./assets/client.js');
      expect(await get(first.route.slice(0, -1) + '?room=retained')).toMatchObject({ status: 308, location: first.route + '?room=retained' });
      expect(await get('/play/tyaga?room=current')).toMatchObject({ status: 308, location: '/play/tyaga/?room=current' });
      expect(await get(first.route + 'assets/model.glb')).toMatchObject({ status: 200, body: 'glTF version one', type: 'model/gltf-binary', cache: 'public,max-age=31536000,immutable' });
      expect((await get('/play/tyaga/assets/model.glb')).body).toBe('glTF current model');
      expect((await get(first.route + 'assets/missing.js')).status).toBe(404);
      expect((await get('/play/tyaga/versions/' + 'f'.repeat(64) + '/')).status).toBe(404);
    } finally { await server.shutdown(); f.store.close(); }
  });
  it('preserves the pinned client identity when the same simulation resumes after deployment', async () => {
    const f = await fixture();
    try {
      const contentHash = 'a'.repeat(64), input = { ...startRequest(), roomId: 'pinned-room', startCommandId: 'pinned-start' };
      const match = await f.engine.create(adapter.gameId, input, { clientContentHash: contentHash, clientRoute: `/play/fixture/versions/${contentHash}/` });
      await f.engine.drain();
      const recovered = new RealtimeEngine({ storage: new LocalStorageClient(f.store), adapters: [adapter], ownerId: 'different-deployment',
        wallNow: () => f.clock.wall, monoNow: () => f.clock.mono });
      await recovered.initialize();
      expect(recovered.status(match.matchId).manifest.clientContentHash).toBe(contentHash);
      expect(recovered.health()).toMatchObject({ ok: true, unavailableMatches: 0 });
      await recovered.drain();
    } finally { f.store.close(); }
  });
});
