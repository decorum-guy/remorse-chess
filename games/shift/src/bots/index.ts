import { stepMatch, viewForSeat } from '../core';
import type { QueuedCommand, ShiftState, TickResult } from '../core';
import { chooseBotCommands } from './policy';
export { chooseBotCommands, pilotWaypoint } from './policy';
/** Human and bot commands reach the same next authoritative tick and receipt path. */
export function advanceWithBots(state: ShiftState, incoming: QueuedCommand[] = []): TickResult {
  const commands = [...incoming];
  if (state.phase === 'active' && state.recoveryTicksRemaining === 0) for (const seat of state.seats) if (seat.bot || state.actors[seat.seatId].substitute) {
    const view = viewForSeat(state, seat.seatId), memory = state.botMemory[seat.seatId];
    commands.push(...chooseBotCommands(view, memory).map(command => ({ seatId: seat.seatId, command })));
  }
  return stepMatch(state, commands);
}
