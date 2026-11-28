import { roomOrigin } from '../core/geometry';
import type { ShiftView, Vec2 } from '../core/types';

/** Extrapolate only an already-authorized visual transition, never a new move. */
export function presentationTick(view: ShiftView, elapsedMs: number, reducedMotion = false): number {
  if (reducedMotion && view.motion) return view.motion.startTick;
  const running = view.phase === 'active' || (view.phase === 'intermission' && !!view.motion);
  return view.tick + (running && view.recoveryTicksRemaining <= 0 ? Math.min(2, Math.max(0, elapsedMs) * .03) : 0);
}

/** The UI aims from the canonical snapshot origin, while its room may be shown
 * at an interpolated tick or held at its start in reduced motion. Room selection
 * remains in displayed coordinates, including a pilot's navigator-style minimap. */
export function canonicalAimPoint(view: ShiftView, point: Vec2 | null, displayedTick: number): Vec2 | null {
  if (!point || view.self.role !== 'pilot' || !view.motion) return point;
  const self = view.actors.find(actor => actor.seatId === view.self.seatId);
  if (self?.spaceId !== view.motion.roomId) return point;
  const displayed = roomOrigin(view.board, self.spaceId, view.motion, displayedTick);
  const canonical = roomOrigin(view.board, self.spaceId, view.motion, view.tick);
  return { x: point.x + canonical.x - displayed.x, z: point.z + canonical.z - displayed.z };
}
