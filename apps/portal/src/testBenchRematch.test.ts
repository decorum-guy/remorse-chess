import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestBenchRematch } from './testBenchRematch';
import type { BotDifficulty, Member, Room } from './types';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

const human = (id: string, seatIndex: number): Member => ({ participantId: id, playerId: id, handle: id, displayName: id, seatIndex, ready: true, controller: { kind: 'human', playerId: id } });
const bot = (id: string, seatIndex: number, difficulty: BotDifficulty): Member => ({ participantId: id, playerId: null, handle: '', displayName: id, seatIndex, ready: true, controller: { kind: 'bot', botProfileId: id, botVersion: '1', difficulty } });
function sourceRoom(): Room {
  return { roomId: 'source', gameId: 'test-bench', title: 'Finished cup', hostPlayerId: 'alice', state: 'finished', capacity: 5, rulesVersion: '1', contentVersion: '1', revision: 8, settings: { cup: 'standard' }, members: [human('alice', 0), human('bob', 1), human('cara', 2), bot('old-normal', 3, 'normal'), bot('old-easy', 4, 'easy')], reservedSeats: 0, matchId: 'old-match', outcome: null, createdAt: 1 };
}
const friends = [{ playerId: 'bob', handle: 'bob', displayName: 'Bob' }, { playerId: 'cara', handle: 'cara', displayName: 'Cara' }];

/** Transport fault fixture: receipts commit before selected response losses. */
function transportFixture(lostResponses: string[] = [], staleSecondBot = false) {
  const faults = new Set(lostResponses);
  const calls: { path: string; method: string; body: string; key: string | null }[] = [];
  const rooms = new Map<string, Room>();
  const receipts = new Map<string, { body: string; result: unknown }>();
  const mutations = { creations: 0, bots: [] as BotDifficulty[], invitations: [] as string[] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const path = url.replace('/api/platform/v1', '');
    if (path === '/session') return Response.json({ user: null, csrfToken: 'test-csrf' });
    const method = options.method ?? 'GET';
    const bodyText = String(options.body ?? '');
    const key = new Headers(options.headers).get('Idempotency-Key');
    calls.push({ path, method, body: bodyText, key });
    if (method === 'GET') {
      const room = rooms.get(path.split('/')[2]);
      expect(room).toBeDefined();
      return Response.json({ room });
    }
    expect(key).toBeTruthy();
    const receiptId = path + ':' + key;
    const prior = receipts.get(receiptId);
    if (prior) { expect(bodyText).toBe(prior.body); return Response.json(prior.result); }
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    let result: unknown;
    let operation: string;
    if (path === '/rooms') {
      mutations.creations++;
      const room = { ...sourceRoom(), roomId: 'target-' + mutations.creations, state: 'lobby' as const, revision: 1, members: [human('alice', 0)], matchId: null };
      rooms.set(room.roomId, room);
      result = { room }; operation = 'create';
    } else {
      const room = rooms.get(path.split('/')[2])!;
      expect(room).toBeDefined();
      if (path.endsWith('/bots')) {
        if (staleSecondBot && mutations.bots.length === 1) { room.revision++; staleSecondBot = false; }
        if (body.expectedRevision !== room.revision) return Response.json({ error: { code: 'STALE_REVISION', message: 'Room changed' } }, { status: 409 });
        mutations.bots.push(body.difficulty as BotDifficulty);
        room.members.push(bot('new-' + mutations.bots.length, room.members.length, body.difficulty as BotDifficulty));
        room.revision++;
        result = { room }; operation = 'bot:' + mutations.bots.length;
      } else {
        expect(path.endsWith('/invitations')).toBe(true);
        mutations.invitations.push(String(body.playerId));
        result = { invitation: { invitationId: 'invite-' + mutations.invitations.length, roomId: room.roomId } };
        operation = 'invite:' + mutations.invitations.length;
      }
    }
    receipts.set(receiptId, { body: bodyText, result: structuredClone(result) });
    if (faults.delete(operation)) throw new TypeError('response lost after commit: ' + operation);
    return Response.json(result);
  }));
  return { calls, rooms, mutations, forgetReceipts: () => receipts.clear() };
}

async function api() {
  const transport = await import('./api');
  await transport.getSession();
  return transport.request;
}

describe('Test Bench rematch resumes the mounted source room', () => {
  it('keeps one room and completed cursors through lost bot/invite responses and a final refresh failure', async () => {
    const server = transportFixture(['bot:2', 'invite:2']);
    const workflow = createTestBenchRematch(sourceRoom(), 'alice', friends, await api());
    const refresh = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('refresh failed')).mockResolvedValue(undefined);
    const first = workflow.complete(refresh);
    expect(workflow.complete(refresh)).toBe(first);
    await expect(first).rejects.toMatchObject({ code: 'NETWORK' });
    expect(server.mutations).toEqual({ creations: 1, bots: ['normal', 'easy'], invitations: [] });
    await expect(workflow.complete(refresh)).rejects.toMatchObject({ code: 'NETWORK' });
    expect(server.mutations).toEqual({ creations: 1, bots: ['normal', 'easy'], invitations: ['bob', 'cara'] });
    expect(refresh).not.toHaveBeenCalled();
    await expect(workflow.complete(refresh)).rejects.toThrow('refresh failed');
    const acknowledgedCalls = server.calls.length;
    await expect(workflow.complete(refresh)).resolves.toBe('target-1');
    expect(server.calls).toHaveLength(acknowledgedCalls);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(server.rooms.size).toBe(1);
    expect(server.mutations).toEqual({ creations: 1, bots: ['normal', 'easy'], invitations: ['bob', 'cara'] });
    expect(server.calls.filter(call => call.method === 'GET')).toHaveLength(0);
    expect(server.calls.filter(call => call.path === '/rooms')).toHaveLength(1);
    const botCalls = server.calls.filter(call => call.path.endsWith('/bots'));
    expect(botCalls).toHaveLength(3);
    expect(botCalls[2]).toEqual(botCalls[1]);
    const inviteCalls = server.calls.filter(call => call.path.endsWith('/invitations'));
    expect(inviteCalls).toHaveLength(3);
    expect(inviteCalls[2]).toEqual(inviteCalls[1]);
  });

  it('replays an uncertain creation with its frozen body and original idempotency key', async () => {
    const server = transportFixture(['create']);
    const source = sourceRoom();
    const workflow = createTestBenchRematch(source, 'alice', friends, await api());
    const refresh = vi.fn(async () => {});
    await expect(workflow.complete(refresh)).rejects.toMatchObject({ code: 'NETWORK' });
    source.title = 'Changed by a later render'; source.settings.cup = 'changed';
    await expect(workflow.complete(refresh)).resolves.toBe('target-1');
    const creates = server.calls.filter(call => call.path === '/rooms');
    expect(creates).toHaveLength(2); expect(creates[1]).toEqual(creates[0]);
    expect(JSON.parse(creates[1].body)).toMatchObject({ title: 'Finished cup', settings: { cup: 'standard' } });
    expect(server.mutations.creations).toBe(1); expect(server.rooms.size).toBe(1);
  });

  it('reads a new revision only after an explicit stale rejection, without repeating an acknowledged bot', async () => {
    const server = transportFixture([], true);
    const workflow = createTestBenchRematch(sourceRoom(), 'alice', friends, await api());
    const refresh = vi.fn(async () => {});
    await expect(workflow.complete(refresh)).rejects.toMatchObject({ code: 'STALE_REVISION', status: 409 });
    expect(server.mutations.bots).toEqual(['normal']);
    expect(server.calls.filter(call => call.method === 'GET')).toHaveLength(0);
    await expect(workflow.complete(refresh)).resolves.toBe('target-1');
    expect(server.calls.filter(call => call.method === 'GET').map(call => call.path)).toEqual(['/rooms/target-1']);
    const botCalls = server.calls.filter(call => call.path.endsWith('/bots'));
    expect(botCalls.map(call => JSON.parse(call.body).expectedRevision)).toEqual([1, 2, 3]);
    expect(botCalls[2].key).not.toBe(botCalls[1].key);
    expect(server.mutations).toEqual({ creations: 1, bots: ['normal', 'easy'], invitations: ['bob', 'cara'] });
  });

  it('does not replace an uncertain bot request after a later stale rejection without its receipt', async () => {
    const server = transportFixture(['bot:2']);
    const workflow = createTestBenchRematch(sourceRoom(), 'alice', friends, await api());
    const refresh = vi.fn(async () => {});
    await expect(workflow.complete(refresh)).rejects.toMatchObject({ code: 'NETWORK' });
    server.forgetReceipts();
    await expect(workflow.complete(refresh)).rejects.toMatchObject({ code: 'STALE_REVISION', status: 409 });
    await expect(workflow.complete(refresh)).rejects.toMatchObject({ code: 'STALE_REVISION', status: 409 });
    expect(server.calls.filter(call => call.method === 'GET')).toHaveLength(0);
    const bots = server.calls.filter(call => call.path.endsWith('/bots'));
    expect(bots.slice(1).every(call => call.body === bots[1].body)).toBe(true);
    expect(server.mutations).toEqual({ creations: 1, bots: ['normal', 'easy'], invitations: [] });
    expect(refresh).not.toHaveBeenCalled();
  });
});
