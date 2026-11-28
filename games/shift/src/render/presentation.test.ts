import { describe, expect, it } from 'vitest';
import { createMatch, viewForSeat } from '../core/engine';
import { roomOrigin } from '../core/geometry';
import type { ShiftView } from '../core/types';
import { canonicalAimPoint, presentationTick } from './presentation';

function movingPilot(): ShiftView {
  const state = createMatch({ arena: 'foundry', teamSize: 2, rotateRoles: false, difficulty: 'normal' }, [
    { seatId: 'tp', team: 'teal', teamIndex: 0, initialRole: 'pilot', displayName: 'Pilot', bot: false },
    { seatId: 'tn', team: 'teal', teamIndex: 1, initialRole: 'navigator', displayName: 'Navigator', bot: false },
    { seatId: 'ap', team: 'amber', teamIndex: 0, initialRole: 'pilot', displayName: 'Other pilot', bot: true },
    { seatId: 'an', team: 'amber', teamIndex: 1, initialRole: 'navigator', displayName: 'Other navigator', bot: true },
  ], 1);
  state.phase = 'active'; state.tick = 5;
  state.motion = { roomId: 'O', from: 4, to: 7, startTick: 0, endTick: 17, team: 'teal', seatId: 'tn' };
  Object.assign(state.actors.tp, { spaceId: 'O', x: 0, z: 0 });
  return viewForSeat(state, 'tp');
}

describe('presentation of an accepted room move', () => {
  it('continues interpolation in intermission, bounded to two ticks', () => {
    const view = movingPilot(); view.phase = 'intermission';
    expect(presentationTick(view, 16)).toBeCloseTo(5.48);
    expect(presentationTick(view, 1000)).toBe(7);
    view.motion = null;
    expect(presentationTick(view, 1000)).toBe(5);
  });

  it('freezes in recovery and keeps reduced motion at the source cell', () => {
    const view = movingPilot(); view.phase = 'intermission'; view.recoveryTicksRemaining = 150;
    expect(presentationTick(view, 1000)).toBe(5);
    expect(presentationTick(view, 1000, true)).toBe(0);
    view.recoveryTicksRemaining = 0; view.phase = 'finished';
    expect(presentationTick(view, 1000)).toBe(5);
  });

  it('preserves all four local aim directions at normal and reduced-motion ticks', () => {
    const view = movingPilot(), before = structuredClone(view);
    const canonical = roomOrigin(view.board, 'O', view.motion, view.tick);
    for (const tick of [0, 5, 5.48, 7]) {
      const displayed = roomOrigin(view.board, 'O', view.motion, tick);
      for (const vector of [{ x: 5, z: 0 }, { x: 0, z: 5 }, { x: -5, z: 0 }, { x: 0, z: -5 }]) {
        const point = canonicalAimPoint(view, { x: displayed.x + vector.x, z: displayed.z + vector.z }, tick)!;
        expect(point.x - canonical.x).toBeCloseTo(vector.x, 10);
        expect(point.z - canonical.z).toBeCloseTo(vector.z, 10);
      }
    }
    const displayed = roomOrigin(view.board, 'O', view.motion, 7);
    const wrongAngle = Math.atan2(displayed.z - canonical.z, 5) * 180 / Math.PI;
    expect(wrongAngle).toBeCloseTo(10.6603482945);
    expect(view).toEqual(before);
  });

  it('does not shift navigator or minimap room selection coordinates', () => {
    const view = movingPilot(), point = { x: 8, z: 11 };
    view.self.role = 'navigator';
    expect(canonicalAimPoint(view, point, 7)).toBe(point);
    view.self.role = 'pilot'; view.actors.find(a => a.seatId === 'tp')!.spaceId = 'A';
    expect(canonicalAimPoint(view, point, 7)).toBe(point);
    expect(canonicalAimPoint(view, null, 7)).toBeNull();
  });
});
