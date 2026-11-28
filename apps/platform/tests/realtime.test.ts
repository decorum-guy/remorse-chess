import { describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealtimeRegistration } from '@iva-games/realtime-server/adapter';
import { createRealtimeHttpServer } from '@iva-games/realtime-server/server';
import { MemoryMailbox } from '../src/mail.js';
import { PlatformService } from '../src/service.js';
import { createPlatformHttpServer } from '../src/http.js';
import { RealtimeEngine } from '../../realtime-server/src/engine.js';
import { LocalRuntimeClient } from '../../realtime-server/src/rpc.js';
import { LocalStorageClient, RealtimeStore } from '../../realtime-server/src/storage.js';
import { verifyTicket } from '../../realtime-server/src/crypto.js';
import { adapter } from '../../realtime-server/tests/fixture.js';

describe('platform to standalone realtime bridge', () => {
  it('serves registered game entry points, preserves the portal and returns 404 for missing assets or unregistered game paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'iva-game-static-'));
    await mkdir(join(directory, 'play/tyaga/assets'), { recursive: true });
    await writeFile(join(directory, 'index.html'), '<h1>Portal fixture</h1>');
    await writeFile(join(directory, 'play/tyaga/index.html'), '<h1>Tyaga fixture</h1>');
    await writeFile(join(directory, 'play/tyaga/assets/world.glb'), 'glTF fixture');
    await writeFile(join(directory, 'play/tyaga/assets/font.ttf'), 'font fixture');
    const platform = new PlatformService({ databasePath: ':memory:', publicOrigin: 'http://platform.test' }); await platform.ready;
    const server = createPlatformHttpServer(platform, { publicOrigin: 'http://platform.test', allowedHosts: ['platform.test'], serveDirectory: directory });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test address unavailable');
    const get = (path: string) => new Promise<{ status: number; body: string; contentType: string | undefined; location: string | undefined }>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${address.port}${path}`, { headers: { Host: 'platform.test' } }, response => {
        const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString(), contentType: response.headers['content-type'], location: response.headers.location }));
      }); req.on('error', reject); req.end();
    });
    try {
      expect(await get('/play/tyaga?room=fixture')).toMatchObject({ status: 308, location: '/play/tyaga/?room=fixture' });
      for (const path of ['/play/tyaga/', '/play/tyaga/room']) expect((await get(path)).body).toBe('<h1>Tyaga fixture</h1>');
      expect((await get('/games')).body).toBe('<h1>Portal fixture</h1>');
      expect(await get('/play/tyaga/assets/world.glb')).toMatchObject({ status: 200, contentType: 'model/gltf-binary' });
      expect(await get('/play/tyaga/assets/font.ttf')).toMatchObject({ status: 200, contentType: 'font/ttf' });
      for (const path of ['/play/tyaga/assets/missing.glb', '/play/unknown/', '/assets/missing.js']) expect((await get(path)).status).toBe(404);
    } finally { await server.shutdown(); platform.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('freezes a real account room, signs only its member ticket, and retains CSRF/Origin checks', async () => {
    const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
    const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('Test port unavailable');
    const port = address.port; await new Promise<void>(resolve => reserve.close(() => resolve()));
    const keys = generateKeyPairSync('ed25519'), trusted = new Map([['platform-test', keys.publicKey]]);
    const store = new RealtimeStore(':memory:'), storage = new LocalStorageClient(store);
    const engine = new RealtimeEngine({ storage, adapters: [adapter] }); await engine.initialize();
    const origin = 'http://127.0.0.1:5284';
    const realtimeServer = createRealtimeHttpServer({ runtime: new LocalRuntimeClient(engine), storage, trustedKeys: trusted,
      allowedHosts: [`127.0.0.1:${port}`], allowedOrigins: [origin] });
    realtimeServer.listen(port, '127.0.0.1'); await once(realtimeServer, 'listening');
    const game = createRealtimeRegistration({ url: `http://127.0.0.1:${port}`, keyId: 'platform-test',
      privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), allowedOrigins: [origin],
      gameId: adapter.gameId, title: 'Runtime fixture', rulesVersion: adapter.rulesVersion, contentVersion: adapter.contentVersion,
      botVersion: adapter.botVersion, route: '/play/fixture/', normalizeSettings: () => ({}) });
    const mailbox = new MemoryMailbox();
    const platform = new PlatformService({ databasePath: ':memory:', publicOrigin: origin, mail: mailbox, games: [game] }); await platform.ready;
    const platformServer = createPlatformHttpServer(platform, { publicOrigin: origin, allowedHosts: ['platform.test'], allowedOrigins: [origin] });
    platformServer.listen(0, '127.0.0.1'); await once(platformServer, 'listening');
    const platformAddress = platformServer.address(); if (!platformAddress || typeof platformAddress === 'string') throw new Error('Test port unavailable');
    try {
      const account = await platform.register({ email: 'fixture@example.invalid', password: 'Test password long enough 123', handle: 'fixture_user', displayName: 'Fixture' });
      const message = mailbox.messages.at(-1)!;
      platform.verifyEmail(new URL(message.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token'));
      let room = platform.createRoom(account.user.playerId, { gameId: adapter.gameId, capacity: 2, settings: {} });
      room = platform.addBot(account.user.playerId, room.roomId, { difficulty: 'normal', expectedRevision: room.revision });
      room = platform.setReady(account.user.playerId, room.roomId, { ready: true, expectedRevision: room.revision });
      platform.startRoom(account.user.playerId, room.roomId, { expectedRevision: room.revision }); await platform.reconcile();
      room = platform.getRoom(account.user.playerId, room.roomId); expect(room.state).toBe('playing'); expect(store.all()).toHaveLength(1);
      const ticketPath = `/api/platform/v1/rooms/${room.roomId}/realtime-ticket`;
      const post = async (body: unknown, csrf = account.session.csrfToken, requestOrigin = origin) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const request = httpRequest(`http://127.0.0.1:${platformAddress.port}${ticketPath}`, { method: 'POST', headers: {
          Host: 'platform.test', Origin: requestOrigin, Cookie: `iva_dev_session=${account.token}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json',
        } }, incoming => { const chunks: Buffer[] = []; incoming.on('data', chunk => chunks.push(Buffer.from(chunk))); incoming.on('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> })); });
        request.on('error', reject); request.end(JSON.stringify(body));
      });
      const issued = await post({}); expect(issued.status).toBe(200);
      const ticket = verifyTicket(issued.body.ticket, trusted, origin, Date.now());
      expect(ticket.playerId).toBe(account.user.playerId); expect(ticket.roomId).toBe(room.roomId); expect(ticket.matchId).toBe(room.matchId);
      expect((await post({}, 'bad-csrf')).status).toBe(403);
      expect((await post({}, account.session.csrfToken, 'https://foreign.invalid')).status).toBe(403);
      expect((await post({ playerId: 'another-account' })).status).toBe(400);
      const second = await post({}); expect(second.status).toBe(200); expect(second.body.ticket).not.toBe(issued.body.ticket);
    } finally { await platformServer.shutdown(); platform.close(); await realtimeServer.shutdown(); store.close(); }
  });
});
