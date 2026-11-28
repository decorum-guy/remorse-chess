import { projectViewChanges } from '../packages/realtime-kit/src/view-projection.mjs';
/** Shared semantics; only immutable map objects are retained. */
export function applyLoadChanges(before, changes) { return projectViewChanges(before, changes, ['map']); }
