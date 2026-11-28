import { describe, expect, it } from 'vitest';
import { goalPosition, lineOfSight, stepMatch, viewForSeat, worldPosition } from '../src/core';
import type { Pose, QueuedCommand, ShiftCommandPayload } from '../src/core';
import { pilotWaypoint } from '../src/bots';
import { advanceLesson, createLesson, lessonCommands } from '../src/ui/lesson';

describe('real lesson progression through production rules', () => {
  it('pilot walks, fires three hits, picks up, rides O and delivers without fixture teleporting', () => {
    const { state, lesson } = createLesson('pilot');
    const steps = new Set<number>();
    for (let n = 0; n < 4000 && lesson.step < 5; n++) {
      steps.add(lesson.step);
      const view = viewForSeat(state, 'self'), actor = state.actors.self;
      const scope = { roundId: state.round, controllerEpoch: actor.controllerEpoch };
      let target: Pose | undefined, aim = actor.aim, fireHeld = false;
      const extra: ShiftCommandPayload[] = [];
      if (lesson.step === 0) target = { spaceId: 'O', x: -3.4, z: 0 };
      if (lesson.step === 1) {
        const enemy = view.actors.find(a => a.team === 'amber' && a.hp > 0);
        if (enemy && lineOfSight(state.settings.arena, state.board, actor, enemy, state.motion, state.tick, 12)) {
          const p = worldPosition(view.board, actor), q = worldPosition(view.board, enemy); aim = Math.atan2(q.z - p.z, q.x - p.x); fireHeld = true;
        } else target = { spaceId: 'O', x: 0, z: 1.3 };
      }
      if (lesson.step === 2) {
        target = { spaceId: 'O', x: 0, z: 0 };
        if (lineOfSight(state.settings.arena, state.board, actor, target, state.motion, state.tick, 0.85)) extra.push({ type: 'interact', actionId: `lesson-pickup-${n}`, ...scope });
      }
      if (lesson.step === 4) target = goalPosition(view.goalSpace);
      const point = target ? pilotWaypoint(view, actor, target) : { x: actor.x, z: actor.z };
      const dx = point.x - actor.x, dz = point.z - actor.z, distance = Math.hypot(dx, dz);
      const withinGoal = lesson.step === 4 && target?.spaceId === actor.spaceId && Math.hypot(actor.x - target.x, actor.z - target.z) < 0.3;
      const command: ShiftCommandPayload = { type: 'input', seq: actor.lastAcceptedSeq + 1, moveX: distance > 0.08 && !withinGoal ? dx / distance : 0, moveZ: distance > 0.08 && !withinGoal ? dz / distance : 0, aim, fireHeld, ...scope };
      stepMatch(state, [...lessonCommands(state, lesson), { seatId: 'self', command }, ...extra.map(command => ({ seatId: 'self', command }))]);
      advanceLesson(state, lesson);
    }
    expect(lesson.step, JSON.stringify({ step: lesson.step, tick: state.tick, actor: state.actors.self, battery: state.battery })).toBe(5);
    expect([...steps]).toEqual([0, 1, 2, 3, 4]); expect(state.stats.self.hits).toBe(3); expect(state.stats.self.deliveries).toBe(1);
    expect(state.stats['teal-1'].allyTransfers).toBe(1); expect(state.stats['teal-1'].batteryTransfers).toBe(1); expect(state.score.teal).toBe(1);
  });
  it('navigator previews, carries pilot around real covers, opens second route and receives an actual rejection', () => {
    const { state, lesson } = createLesson('navigator');
    const steps = new Set<number>(); let rejectedReason = '';
    for (let n = 0; n < 3000 && lesson.step < 5; n++) {
      steps.add(lesson.step); const view = viewForSeat(state, 'self'), actor = state.actors.self;
      const commands: QueuedCommand[] = lessonCommands(state, lesson), scope = { roundId: state.round, controllerEpoch: actor.controllerEpoch };
      if (lesson.step === 0) {
        const option = view.shiftOptions.find(o => o.roomId === 'O'); expect(option?.allowed).toBe(true); expect(option?.doorsAfter.some(d => d.spaceId === 'O' && d.direction === 'west' && d.open)).toBe(true);
        lesson.selected = true;
      }
      if (lesson.step === 1 && !state.motion && state.stats.self.shifts === 0) commands.push({ seatId: 'self', command: { type: 'shift', actionId: 'tutorial-ride', roomId: 'O', expectedBoardRevision: state.boardRevision, ...scope } });
      if (lesson.step === 3 && !state.motion) {
        const option = view.shiftOptions.find(o => o.allowed);
        if (option) commands.push({ seatId: 'self', command: { type: 'shift', actionId: 'tutorial-second', roomId: option.roomId, expectedBoardRevision: state.boardRevision, ...scope } });
      }
      if (lesson.step === 4 && view.cooldownUntilTick.teal <= view.tick) {
        const option = view.shiftOptions.find(o => o.reason === 'NOT_ADJACENT');
        if (option) commands.push({ seatId: 'self', command: { type: 'shift', actionId: 'tutorial-impossible', roomId: option.roomId, expectedBoardRevision: state.boardRevision, ...scope } });
      }
      const result = stepMatch(state, commands);
      if (result.receipts.some(r => r.actionId === 'tutorial-impossible' && !r.accepted)) { lesson.rejected = true; rejectedReason = result.receipts.find(r => r.actionId === 'tutorial-impossible')?.reason ?? ''; }
      advanceLesson(state, lesson);
    }
    expect(lesson.step, JSON.stringify({ step: lesson.step, actor: state.actors['teal-1'] })).toBe(5);
    expect([...steps]).toEqual([0, 1, 2, 3, 4]); expect(state.stats.self.shifts).toBe(2); expect(state.actors['teal-1'].spaceId).not.toBe('O'); expect(rejectedReason).toBe('NOT_ADJACENT');
  });
});
