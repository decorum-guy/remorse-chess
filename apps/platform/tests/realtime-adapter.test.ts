import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createForpostRegistration } from '../src/realtime-adapter';
import type { StartMatchRequest } from '@iva-games/session-kit';

const paths: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function adapter() {
  const path = mkdtempSync(join(tmpdir(), 'forpost-bridge-fixture-')); paths.push(path);
  return createForpostRegistration({ baseUrl: 'http://127.0.0.1:4331', publicOrigin: 'http://localhost', keyId: 'qa-key', signingKeyPath: join(path, 'key.pem') }).registration.runtime!;
}
const command: StartMatchRequest = { startCommandId: 'frozen-start', roomId: 'frozen-room', hostPlayerId: 'actual-host', rulesVersion: 'forpost-0.1', contentVersion: 'forpost-content-1', participants: [], settings: {} };

it('preserves the frozen host/start and exposes only validated queue metadata from the authenticated bridge', async () => {
  const sent: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_url: URL, request: RequestInit) => {
    sent.push(request);
    return new Response(JSON.stringify({ error: { code: 'SERVER_BUSY' }, waiting: { reason: 'capacity', retryAt: 9000, queuePosition: 2,
      reservationExpiresAt: 15_000, hidden: 'must-not-enter-room-view' } }), { status: 503 });
  });
  await expect(adapter().createMatch(command)).rejects.toMatchObject({ code: 'START_WAITING', startWaiting: {
    reason: 'capacity', retryAt: 9000, queuePosition: 2, reservationExpiresAt: 15_000 } });
  expect(JSON.parse(String(sent[0].body))).toEqual(command);
  expect((sent[0].headers as Record<string, string>)['X-Iva-Signature']).toBeTruthy();
});

it('does not present malformed bridge data as a valid capacity queue state', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ waiting: { reason: 'capacity', retryAt: -1, queuePosition: 0 } }), { status: 503 }));
  await expect(adapter().createMatch(command)).rejects.toMatchObject({ code: 'GAME_UNAVAILABLE' });
});
