import { movePose } from '../core/geometry';
import type { PilotInput, ShiftView, VisibleActor } from '../core/types';

/** Presentation only. Ownership, visibility, damage and the score remain in ShiftView. */
export function predictPilot(view: ShiftView, inputs: readonly PilotInput[], latest: PilotInput, remainderMs: number): VisibleActor | null {
  const actor = view.actors.find(a => a.seatId === view.self.seatId);
  if (!actor || view.self.role !== 'pilot') return null;
  if (view.phase !== 'active' || view.recoveryTicksRemaining || actor.hp <= 0) return actor;
  let pose = { spaceId: actor.spaceId, x: actor.x, z: actor.z };
  const advance = (input: PilotInput, seconds: number) => {
    const length = Math.max(1, Math.hypot(input.moveX, input.moveZ));
    const distance = (actor.carrying ? 3.6 : 4.6) * seconds;
    pose = movePose(view.settings.arena, view.board, pose, input.moveX / length * distance, input.moveZ / length * distance, view.motion);
  };
  // A missing connection cannot extrapolate beyond the input-timeout budget.
  for (const input of inputs.slice(-7)) advance(input, 1 / 30);
  advance(latest, Math.max(0, Math.min(1000 / 30, remainderMs)) / 1000);
  return { ...actor, ...pose, aim: latest.aim };
}
