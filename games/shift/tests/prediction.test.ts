import { describe, expect, it } from 'vitest';
import { viewForSeat } from '../src/core';
import { createLesson } from '../src/ui/lesson';
import { predictPilot } from '../src/ui/prediction';
const right = { moveX: 1, moveZ: 0, aim: 0, fireHeld: false };
const stop = { moveX: 0, moveZ: 0, aim: 0, fireHeld: false };

describe('own-pilot presentation reconciliation', () => {
  it('moves immediately within the input timeout, without mutating the server view', () => {
    const { state } = createLesson('pilot');
    Object.assign(state.actors.self, { spaceId: 'west', x: 0, z: 0 });
    const view = viewForSeat(state, 'self'), before = structuredClone(view);
    const predicted = predictPilot(view, [right], right, 0)!;
    expect(predicted.x).toBeCloseTo(4.6 / 30, 5);
    expect(view).toEqual(before);
    const capped = predictPilot(view, Array.from({ length: 90 }, () => right), right, 20_000)!;
    expect(capped.x).toBeLessThanOrEqual(4.6 * 8 / 30 + .00001);
  });
  it('uses sealed doors during confirmed motion and accepts canonical space changes', () => {
    const { state } = createLesson('pilot');
    Object.assign(state.actors.self, { spaceId: 'O', x: -3.4, z: 0 });
    state.motion = { roomId: 'O', from: 4, to: 7, startTick: 0, endTick: 17, team: 'teal', seatId: 'teal-1' };
    let view = viewForSeat(state, 'self');
    const left = { ...right, moveX: -1 };
    const predicted = predictPilot(view, Array.from({ length: 7 }, () => left), left, 33)!;
    expect(predicted.spaceId).toBe('O');
    expect(predicted.x).toBeGreaterThanOrEqual(-3.72);
    Object.assign(state.actors.self, { spaceId: 'F', x: 1, z: -2 });
    state.motion = null; view = viewForSeat(state, 'self');
    expect(predictPilot(view, [], stop, 0)).toMatchObject({ spaceId: 'F', x: 1, z: -2 });
  });
  it('preserves authoritative health, battery and freeze state', () => {
    const { state } = createLesson('pilot');
    Object.assign(state.actors.self, { spaceId: 'west', x: 0, z: 0, hp: 2 });
    state.battery = { mode: 'carried', carrierId: 'self', spaceId: 'west', x: 0, z: 0, returnAtTick: null };
    let view = viewForSeat(state, 'self');
    const predicted = predictPilot(view, [right], right, 0)!;
    expect(predicted).toMatchObject({ hp: 2, carrying: true });
    expect(predicted.x).toBeCloseTo(3.6 / 30, 8);
    state.recoveryTicksRemaining = 150; view = viewForSeat(state, 'self');
    expect(predictPilot(view, [right], right, 33)).toEqual(view.actors.find(a => a.seatId === 'self'));
  });
});
