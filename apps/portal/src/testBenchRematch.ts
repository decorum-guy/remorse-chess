import type { BotDifficulty, PublicPlayer, Room } from './types';

type Request = <T>(path: string, body?: unknown) => Promise<T>;

/** One rematch attempt retained by its mounted source room, not across reloads. */
export function createTestBenchRematch(source: Room, playerId: string, friends: readonly PublicPlayer[], request: Request) {
  const creation = { gameId: 'test-bench', capacity: source.capacity, title: source.title, settings: structuredClone(source.settings) };
  const bots = source.members.flatMap(member => member.controller.kind === 'bot' ? [member.controller.difficulty] : []);
  const friendIds = new Set(friends.map(friend => friend.playerId));
  const invitations = source.members.flatMap(member => member.controller.kind === 'human' && member.playerId !== playerId && member.playerId && friendIds.has(member.playerId) ? [{ playerId: member.playerId }] : []);
  let target: Room | null = null;
  let botIndex = 0;
  let invitationIndex = 0;
  let pendingBot: { difficulty: BotDifficulty; expectedRevision: number } | null = null;
  let pendingBotUnknown = false;
  let refreshRevision = false;
  let running: Promise<string> | null = null;

  async function resume(refresh: () => Promise<void>): Promise<string> {
    if (!target) target = (await request<{ room: Room }>('/rooms', creation)).room;
    while (botIndex < bots.length) {
      if (refreshRevision) {
        target = (await request<{ room: Room }>('/rooms/' + target.roomId)).room;
        refreshRevision = false;
      }
      pendingBot ??= { difficulty: bots[botIndex], expectedRevision: target.revision };
      try {
        target = (await request<{ room: Room }>('/rooms/' + target.roomId + '/bots', pendingBot)).room;
      } catch (error) {
        const failure = error as { code?: string; status?: number } | null;
        if (failure?.code === 'STALE_REVISION' && failure.status === 409 && !pendingBotUnknown) {
          // A first, explicit rejection permits a new revision. A prior unknown
          // outcome remains pinned even if a later retry cannot find its receipt.
          pendingBot = null;
          refreshRevision = true;
        } else if (!failure?.status || failure.status >= 500) pendingBotUnknown = true;
        // Unknown outcomes keep the exact body so api.ts can replay its receipt.
        throw error;
      }
      pendingBot = null;
      pendingBotUnknown = false;
      botIndex++;
    }
    while (invitationIndex < invitations.length) {
      await request('/rooms/' + target.roomId + '/invitations', invitations[invitationIndex]);
      invitationIndex++;
    }
    await refresh();
    return target.roomId;
  }

  return {
    complete(refresh: () => Promise<void>): Promise<string> {
      running ??= resume(refresh).finally(() => { running = null; });
      return running;
    },
  };
}
