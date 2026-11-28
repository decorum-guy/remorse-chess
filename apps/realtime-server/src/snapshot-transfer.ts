import { RealtimeError } from '@iva-games/realtime-kit';
import type { Snapshot } from '@iva-games/realtime-kit';

/** Negotiated only between a trusted, archived worker and its host. The public
 * snapshot protocol remains unchanged. Old hosts/workers use ordinary views. */
export const STATIC_VIEW_TRANSFER = 'iva-static-view@1';
const MAX_CONNECTIONS = 256;
type Fields = Record<string, unknown>;
interface Entry { scope: string; revision: number; fields: Fields }
interface Transfer { type: typeof STATIC_VIEW_TRANSFER; snapshot: Snapshot; revision: number; fields?: Fields }
const scope = (snapshot: Snapshot): string => `${snapshot.matchId}\n${snapshot.participantId}\n${snapshot.epoch}\n${snapshot.controllerGeneration}`;
const record = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const validKey = (key: string): boolean => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);

export function snapshotConnection(method: string, args: readonly unknown[]): string | undefined {
  const value = method === 'connect' ? args[1] : ['snapshot', 'claim', 'resync'].includes(method) ? args[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** Only explicitly declared top-level immutable fields may be retained. Each
 * observer has its own cache, including when two views happen to share a map. */
export class SnapshotEncoder {
  private entries = new Map<string, Entry>();
  encode(connectionId: string, snapshot: Snapshot, keys: readonly string[]): Snapshot | Transfer {
    if (keys.length > 16 || keys.some(key => !validKey(key)) || new Set(keys).size !== keys.length) throw new RealtimeError('INVALID_STATIC_VIEW_FIELDS', 500);
    if (!keys.length || !record(snapshot.view)) { this.entries.delete(connectionId); return snapshot; }
    const previous = this.entries.get(connectionId);
    // A full ordinary snapshot is always a safe compatibility fallback.
    if (!previous && this.entries.size >= MAX_CONNECTIONS) return snapshot;
    const fields: Fields = {}, view = { ...snapshot.view };
    for (const key of keys) if (Object.hasOwn(view, key)) { fields[key] = view[key]; delete view[key]; }
    const currentScope = scope(snapshot), fieldKeys = Object.keys(fields);
    const changed = !previous || previous.scope !== currentScope || Object.keys(previous.fields).length !== fieldKeys.length ||
      fieldKeys.some(key => !Object.hasOwn(previous.fields, key) || !Object.is(previous.fields[key], fields[key]));
    const entry = changed ? { scope: currentScope, revision: (previous?.revision ?? 0) + 1, fields } : previous;
    this.entries.set(connectionId, entry);
    return { type: STATIC_VIEW_TRANSFER, snapshot: { ...snapshot, view }, revision: entry.revision, ...(changed ? { fields } : {}) };
  }
  delete(connectionId: string): void { this.entries.delete(connectionId); }
  clear(): void { this.entries.clear(); }
}

export class SnapshotDecoder {
  private entries = new Map<string, Entry>();
  decode(connectionId: string, value: unknown): unknown {
    if (!record(value) || value.type !== STATIC_VIEW_TRANSFER) { this.entries.delete(connectionId); return value; }
    const transfer = value as unknown as Transfer, snapshot = transfer.snapshot;
    if (!record(snapshot) || snapshot.type !== 'full' || !record(snapshot.view) || !Number.isSafeInteger(transfer.revision) || transfer.revision < 1) throw new RealtimeError('INVALID_SNAPSHOT_TRANSFER', 503);
    const currentScope = scope(snapshot), previous = this.entries.get(connectionId);
    let entry = previous;
    if (Object.hasOwn(transfer, 'fields')) {
      if (!record(transfer.fields) || Object.keys(transfer.fields).length > 16 || Object.keys(transfer.fields).some(key => !validKey(key) || Object.hasOwn(snapshot.view as Fields, key))) throw new RealtimeError('INVALID_SNAPSHOT_TRANSFER', 503);
      if (!previous && this.entries.size >= MAX_CONNECTIONS) throw new RealtimeError('SNAPSHOT_TRANSFER_CAPACITY', 503);
      entry = { scope: currentScope, revision: transfer.revision, fields: transfer.fields };
      this.entries.set(connectionId, entry);
    }
    if (!entry || entry.scope !== currentScope || entry.revision !== transfer.revision) throw new RealtimeError('SNAPSHOT_TRANSFER_BASELINE_MISSING', 503);
    return { ...snapshot, view: { ...snapshot.view, ...entry.fields } };
  }
  delete(connectionId: string): void { this.entries.delete(connectionId); }
  clear(): void { this.entries.clear(); }
}
