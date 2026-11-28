import { describe, expect, it } from 'vitest';
import { LIVE_PROTOCOL, parseLiveClientFrame } from '@iva-games/session-kit';
import type { LiveServerFrame } from '@iva-games/session-kit';
import { connectSeat, CONTENT_VERSION, RULES_VERSION, stepMatch, viewForSeat, WIRE_VERSION } from '../src/core';
import type { InputCommand, Receipt, ShiftCommand, ShiftCommandPayload, ShiftView } from '../src/core';
import { createLesson } from '../src/ui/lesson';
import { liveCloseStatus, ShiftLiveChannel } from '../src/ui/session';

const right = { moveX: 1, moveZ: 0, aim: 0, fireHeld: false };
const scope = (epoch = 'transport-one') => ({ protocol: LIVE_PROTOCOL, wireVersion: WIRE_VERSION, roomId: 'room-one', matchId: 'match-one', epoch, gameId: 'shift', rulesVersion: RULES_VERSION, contentVersion: CONTENT_VERSION });
function snapshot(view: ShiftView, epoch = 'transport-one', serverTime = 100): Extract<LiveServerFrame, { type: 'snapshot' }> {
  return { ...scope(epoch), type: 'snapshot', tick: view.tick, serverTime, lastAcceptedSeq: view.self.lastAcceptedSeq, view };
}
function shift(view: ShiftView, actionId = 'shift-command-one'): ShiftCommand {
  return { type: 'shift', actionId, roomId: 'O', expectedBoardRevision: view.boardRevision, roundId: view.round, controllerEpoch: view.self.controllerEpoch };
}
function receiptFrame(receipt: Receipt, epoch = 'transport-one'): LiveServerFrame {
  return { ...scope(epoch), type: 'receipt', actionId: receipt.actionId, tick: 0, result: receipt };
}
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, values };
}

describe('Shift client on iva-live@1', () => {
  it('waits for a complete authenticated scope and sends frames accepted by the shared parser', () => {
    const { state } = createLesson('pilot'), view = viewForSeat(state, 'self');
    const client = new ShiftLiveChannel('room-one', 'match-one');
    client.input = right;
    expect(client.inputFrame(0)).toBeNull();
    expect(client.receive({ type: 'snapshot', view }, 0)).toBeNull();
    expect(client.receive({ ...snapshot(view), lastAcceptedSeq: undefined }, 0)).toBeNull();
    expect(client.receive(snapshot(view), 0)).toMatchObject({ type: 'snapshot', changed: true });
    client.input = right;
    const input = client.inputFrame(34)!;
    expect(parseLiveClientFrame(input, client.scope!)).toEqual(input);
    expect(input).toMatchObject({ protocol: LIVE_PROTOCOL, epoch: 'transport-one', type: 'input', seq: 0, payload: { type: 'input', ...right, seq: 0, controllerEpoch: view.self.controllerEpoch, roundId: 1 } });
    const command: ShiftCommandPayload = { type: 'interact', actionId: 'interact-command-one', roundId: view.round, controllerEpoch: view.self.controllerEpoch };
    client.queue(command);
    const frame = client.commandFrames()[0];
    expect(parseLiveClientFrame(frame, client.scope!)).toEqual(frame);
    expect(frame).toMatchObject({ type: 'command', actionId: command.actionId, expectedRevision: view.boardRevision, payload: command });
    expect(frame).not.toHaveProperty('version');
  });

  it('reconciles from applied sequences, including a packet coalesced before the core tick', () => {
    const { state } = createLesson('pilot');
    Object.assign(state.actors.self, { spaceId: 'west', x: 0, z: 0 });
    const client = new ShiftLiveChannel('room-one', 'match-one');
    client.receive(snapshot(viewForSeat(state, 'self')), 0); client.input = right;
    const first = client.inputFrame(34)!, latest = client.inputFrame(68)!;
    expect(first).toMatchObject({ seq: 0 }); expect(latest).toMatchObject({ seq: 1 });
    expect(client.predictSelf(68)!.x).toBeCloseTo(2 * 4.6 / 30, 8);
    // The gateway coalesces two received inputs. Only the latest reaches rules.
    stepMatch(state, [{ seatId: 'self', command: latest.payload as InputCommand }]);
    const canonical = viewForSeat(state, 'self');
    expect(canonical.self.lastAcceptedSeq).toBe(1);
    client.receive(snapshot(canonical), 68);
    expect(client.predictSelf(68)!.x).toBeCloseTo(state.actors.self.x, 8);
    expect(client.inputFrame(102)).toMatchObject({ seq: 2 });
  });

  it('replays an immutable committed action after a lost receipt and new transport/core epochs', () => {
    const { state } = createLesson('navigator'), client = new ShiftLiveChannel('room-one', 'match-one');
    const initial = viewForSeat(state, 'self'); client.receive(snapshot(initial), 0);
    const command = shift(initial); client.queue(command);
    const first = client.commandFrames()[0];
    const result = stepMatch(state, [{ seatId: 'self', command: first.payload as ShiftCommand }]).receipts[0];
    expect(result.accepted).toBe(true);
    client.beginConnection();
    expect(client.commandFrames()).toEqual([]);
    connectSeat(state, 'self');
    client.receive(snapshot(viewForSeat(state, 'self'), 'transport-two'), 100);
    const replay = client.commandFrames()[0];
    expect(replay).toEqual({ ...first, epoch: 'transport-two' });
    const repeated = stepMatch(state, [{ seatId: 'self', command: replay.payload as ShiftCommand }]).receipts[0];
    expect(repeated).toEqual(result); expect(state.stats.self.shifts).toBe(1);
    expect(client.receive(receiptFrame(repeated, 'transport-two'), 134)).toEqual({ type: 'receipt', receipt: result });
    expect(client.pending.size).toBe(0);
    expect(client.receive(receiptFrame(repeated, 'transport-two'), 150)).toBeNull();
  });

  it('never silently upgrades an uncommitted old command to the new controller', () => {
    const { state } = createLesson('navigator'), client = new ShiftLiveChannel('room-one', 'match-one');
    client.receive(snapshot(viewForSeat(state, 'self')), 0); client.queue(shift(client.view!));
    client.beginConnection(); connectSeat(state, 'self');
    client.receive(snapshot(viewForSeat(state, 'self'), 'transport-two'), 100);
    const replay = client.commandFrames()[0];
    const result = stepMatch(state, [{ seatId: 'self', command: replay.payload as ShiftCommand }]).receipts[0];
    expect(result).toMatchObject({ accepted: false, reason: 'STALE_EPOCH' });
    expect(state.stats.self.shifts).toBe(0);
    client.receive(receiptFrame(result, 'transport-two'), 120);
    expect(client.pending.size).toBe(0);
  });

  it('keeps pending IDs through round changes and binds receipts to the right action and seat', () => {
    const { state } = createLesson('navigator'), client = new ShiftLiveChannel('room-one', 'match-one');
    client.receive(snapshot(viewForSeat(state, 'self')), 0); client.queue(shift(client.view!));
    const pending = client.commandFrames()[0];
    state.round++; state.tick++;
    client.receive(snapshot(viewForSeat(state, 'self')), 100);
    expect(client.commandFrames()[0]).toEqual(pending);
    const result = stepMatch(state, [{ seatId: 'self', command: pending.payload as ShiftCommand }]).receipts[0];
    expect(result.reason).toBe('STALE_ROUND');
    expect(client.receive(receiptFrame({ ...result, seatId: 'another-player' }), 134)).toBeNull();
    expect(client.receive({ ...receiptFrame(result), actionId: 'another-action' }, 134)).toBeNull();
    expect(client.pending.size).toBe(1);
    expect(client.receive(receiptFrame(result), 134)).toEqual({ type: 'receipt', receipt: result });
  });

  it('restores the same pending envelope after reload only for its original seat and match', () => {
    const saved = storage(), { state } = createLesson('navigator');
    const first = new ShiftLiveChannel('room-one', 'match-one', saved);
    first.receive(snapshot(viewForSeat(state, 'self')), 0); first.queue(shift(first.view!));
    const original = first.commandFrames()[0];
    connectSeat(state, 'self');
    const reloaded = new ShiftLiveChannel('room-one', 'match-one', saved);
    reloaded.receive(snapshot(viewForSeat(state, 'self'), 'transport-two'), 200);
    expect(reloaded.commandFrames()[0]).toEqual({ ...original, epoch: 'transport-two' });
    const foreign = new ShiftLiveChannel('room-one', 'match-one', saved);
    foreign.receive(snapshot(viewForSeat(state, 'amber-0'), 'transport-three'), 300);
    expect(foreign.commandFrames()).toEqual([]);
    expect(saved.values.size).toBe(0);
  });

  it('freezes pending payload/revision and rejects action-ID reuse with different content', () => {
    const { state } = createLesson('navigator'), client = new ShiftLiveChannel('room-one', 'match-one');
    client.receive(snapshot(viewForSeat(state, 'self')), 0);
    const command = shift(client.view!), initialRevision = state.boardRevision; client.queue(command);
    command.roomId = 'F';
    expect(client.commandFrames()[0]).toMatchObject({ payload: { roomId: 'O' }, expectedRevision: initialRevision });
    expect(client.queue(command)).toBe('ACTION_CONFLICT');
    const interact = { type: 'interact' as const, actionId: 'interact-command', roundId: state.round, controllerEpoch: state.actors.self.controllerEpoch };
    client.queue(interact); state.boardRevision++; state.tick++;
    client.receive(snapshot(viewForSeat(state, 'self')), 100);
    expect(client.queue(interact)).toBeNull();
    expect(client.commandFrames(interact.actionId)[0]).toMatchObject({ expectedRevision: initialRevision });
  });

  it('retries transient command errors with the same ID but clears terminal rejections', () => {
    const { state } = createLesson('navigator'), client = new ShiftLiveChannel('room-one', 'match-one');
    client.receive(snapshot(viewForSeat(state, 'self')), 0); client.queue(shift(client.view!));
    const pending = client.commandFrames()[0];
    client.receive({ ...scope(), type: 'error', code: 'RATE_LIMITED', message: 'Retry', actionId: 'shift-command-one' }, 100);
    expect(client.commandFrames()[0]).toEqual(pending);
    client.receive({ ...scope(), type: 'error', code: 'GAME_TIMEOUT', message: 'Retry', actionId: 'shift-command-one' }, 200);
    expect(client.commandFrames()[0]).toEqual(pending);
    client.receive({ ...scope(), type: 'error', code: 'MATCH_FINISHED', message: 'Finished', actionId: 'shift-command-one' }, 300);
    expect(client.pending.size).toBe(0);
  });

  it('rejects another scope or stale epoch without replacing the permitted view', () => {
    const { state } = createLesson('pilot'), client = new ShiftLiveChannel('room-one', 'match-one'), first = viewForSeat(state, 'self');
    client.receive(snapshot(first), 0);
    const other = structuredClone(first); other.tick = 80;
    expect(client.receive(snapshot(other, 'transport-stale'), 100)).toBeNull();
    expect(client.receive({ ...snapshot(other), roomId: 'room-other' }, 100)).toBeNull();
    expect(client.view).toBe(first);
    expect(client.receive({ ...snapshot(other), matchId: 'match-other' }, 100)).toEqual({ type: 'error', code: 'MATCH_CHANGED' });
    expect(client.receive({ ...snapshot(other), wireVersion: 'incompatible@2' }, 100)).toEqual({ type: 'error', code: 'INCOMPATIBLE_VERSION' });
  });

  it('keeps sequence monotonic through round changes and resets only on a fresh transport epoch', () => {
    const { state } = createLesson('pilot'), client = new ShiftLiveChannel('room-one', 'match-one');
    client.receive(snapshot(viewForSeat(state, 'self')), 0); client.input = right;
    expect(client.inputFrame(34)).toMatchObject({ seq: 0 }); expect(client.inputFrame(68)).toMatchObject({ seq: 1 });
    state.round++; state.tick++;
    client.receive(snapshot(viewForSeat(state, 'self')), 100);
    expect(client.inputFrame(102)).toMatchObject({ seq: 2, payload: { moveX: 0, fireHeld: false, roundId: 2 } });
    client.beginConnection(); connectSeat(state, 'self');
    client.receive(snapshot(viewForSeat(state, 'self'), 'transport-two'), 200);
    expect(client.inputFrame(204)).toMatchObject({ seq: 0, epoch: 'transport-two' });
  });

  it('caps input to 30 per rolling second even across reconnect and stops throughout recovery/final', () => {
    const { state } = createLesson('pilot'), client = new ShiftLiveChannel('room-one', 'match-one');
    client.receive(snapshot(viewForSeat(state, 'self')), 0);
    let sent = 0;
    for (let i = 0; i < 50; i++) if (client.inputFrame(i * 10)) sent++;
    expect(sent).toBe(30);
    client.beginConnection(); connectSeat(state, 'self');
    client.receive(snapshot(viewForSeat(state, 'self'), 'transport-two'), 600);
    expect(client.inputFrame(900)).toBeNull();
    expect(client.inputFrame(1000)).not.toBeNull();
    state.recoveryTicksRemaining = 150;
    client.receive(snapshot(viewForSeat(state, 'self'), 'transport-two'), 1100);
    expect(client.inputFrame(1100)).toBeNull();
    expect(client.predictSelf(2000)).toEqual(client.view!.actors.find(actor => actor.seatId === 'self'));
    state.recoveryTicksRemaining = 0; state.phase = 'finished';
    client.receive(snapshot(viewForSeat(state, 'self'), 'transport-two'), 2100);
    expect(client.inputFrame(2200)).toBeNull();
  });

  it('does not rerender unchanged 15Hz final snapshots but shows a freeze countdown at the same tick', () => {
    const { state } = createLesson('pilot'), client = new ShiftLiveChannel('room-one', 'match-one');
    state.phase = 'finished'; const final = viewForSeat(state, 'self');
    expect(client.receive(snapshot(final), 0)).toMatchObject({ changed: true });
    const original = client.view;
    for (let i = 1; i <= 30; i++) expect(client.receive(snapshot(structuredClone(final), 'transport-one', 100 + i * 67), i * 67)).toMatchObject({ changed: false });
    expect(client.view).toBe(original);
    state.phase = 'active'; state.recoveryTicksRemaining = 150;
    expect(client.receive(snapshot(viewForSeat(state, 'self')), 2200)).toMatchObject({ changed: true });
    state.recoveryTicksRemaining--;
    expect(client.receive(snapshot(viewForSeat(state, 'self')), 2267)).toMatchObject({ changed: true });
    expect(client.view!.tick).toBe(final.tick);
    expect(client.view!.recoveryTicksRemaining).toBe(149);
  });

  it('distinguishes timeout/restart retries from authorization, changed match and tab takeover', () => {
    expect(liveCloseStatus(4001)).toEqual({ status: 'STALE_EPOCH', retry: false });
    expect(liveCloseStatus(1000, 'LIVE_SUPERSEDED')).toEqual({ status: 'STALE_EPOCH', retry: false });
    expect(liveCloseStatus(4003, 'FORBIDDEN')).toEqual({ status: 'FORBIDDEN', retry: false });
    expect(liveCloseStatus(4003, 'UNAUTHENTICATED')).toEqual({ status: 'FORBIDDEN', retry: false });
    expect(liveCloseStatus(4003, 'LIVE_SCOPE_MISMATCH')).toEqual({ status: 'MATCH_CHANGED', retry: false });
    expect(liveCloseStatus(4003, 'GAME_TIMEOUT')).toEqual({ status: 'reconnecting', retry: true });
    expect(liveCloseStatus(1012)).toEqual({ status: 'reconnecting', retry: true });
    expect(liveCloseStatus(1013)).toEqual({ status: 'reconnecting', retry: true });
  });
});
