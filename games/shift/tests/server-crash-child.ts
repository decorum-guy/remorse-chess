import { ShiftRuntime } from '../src/server/runtime';
import { randomUUID } from 'node:crypto';
import type { StartMatchRequest } from '@iva-games/session-kit';
import type { ShiftView } from '../src/core/types';

// Isolated subprocess fixture. The parent deliberately SIGKILLs it after receipt.
const request: StartMatchRequest = {
  startCommandId: 'crash-start', roomId: 'crash-room', rulesVersion: 'shift@1', contentVersion: 'shift-content@1',
  settings: { arena: 'foundry', teamSize: 2, rotateRoles: false, difficulty: 'normal' },
  participants: Array.from({ length: 4 }, (_, i) => ({
    participantId: `seat-${i}`, playerId: i % 2 === 0 ? `player-${i}` : null, displayName: `Crash ${i}`, seatIndex: i,
    controller: i % 2 === 0 ? { kind: 'human' as const, playerId: `player-${i}` }
      : { kind: 'bot' as const, botProfileId: 'shift:normal', botVersion: 'shift-bot@1', difficulty: 'normal' as const },
  })),
};
const runtime = new ShiftRuntime({ databasePath: process.argv[2], autoTick: false });
const { matchId } = await runtime.createMatch(request);
const epoch = randomUUID();
await runtime.liveConnect(matchId, 'player-0', epoch);
runtime.advanceTicks(211);
const before = (await runtime.liveSnapshot(matchId, 'player-0', epoch)).view as ShiftView;
const command = { type: 'shift', roundId: before.round, controllerEpoch: before.self.controllerEpoch, roomId: 'O', expectedBoardRevision: before.boardRevision };
const queued = runtime.applyAction(matchId, 'player-0', { actionId: 'crash-shift-action', expectedRevision: before.boardRevision, payload: command });
runtime.advanceTicks();
const receipt = await queued;
const moving = (await runtime.liveSnapshot(matchId, 'player-0', epoch)).view as ShiftView;
process.send?.({ matchId, receipt, command, tick: moving.tick, motion: moving.motion });
// No shutdown handler: this test must exercise SQLite recovery, not close().
setInterval(() => {}, 1000);
