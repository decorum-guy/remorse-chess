export interface ProjectionChange { path: (string | number)[]; value?: unknown; remove?: true }
export function projectViewChanges(before: unknown, changes: readonly ProjectionChange[], immutableTopLevelFields?: readonly string[]): unknown;
