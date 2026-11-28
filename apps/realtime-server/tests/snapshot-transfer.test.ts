import { describe, expect, it } from 'vitest';
import { REALTIME_PROTOCOL } from '@iva-games/realtime-kit';
import type { Snapshot } from '@iva-games/realtime-kit';
import { SnapshotEncoder, SnapshotDecoder, STATIC_VIEW_TRANSFER, snapshotConnection } from '../src/snapshot-transfer.js';

function snapshot(view: unknown, updates: Partial<Snapshot> = {}): Snapshot {
  return { type: 'full', protocolVersion: REALTIME_PROTOCOL, matchId: 'match', epoch: 1, controllerGeneration: 2,
    snapshotSeq: 1, worldTick: 1, committedJournalSeq: 1, serverTime: 10, phase: 'running', participantId: 'observer1',
    manifest: { gameId: 'fixture', rulesVersion: 'rules1', contentVersion: 'content1', protocolVersion: REALTIME_PROTOCOL,
      physicsBuildHash: 'physics1', runtimeArtifactId: 'artifact1', serializerVersion: 'serializer1', botVersion: 'bots1', tickRate: 60, snapshotRate: 20 },
    lastConsumedInputSeq: 1, controls: [], hasControl: true, elapsedSeconds: 1, attempt: 0, resumeAt: null, returnUntil: null,
    outcome: null, view, ...updates };
}

describe('negotiated observer-scoped immutable view transfer', () => {
  it('crosses a real structured clone boundary once and preserves mutable values on every snapshot', () => {
    const encoder = new SnapshotEncoder(), decoder = new SnapshotDecoder();
    const map = { platforms: [{ x: 20, shape: 'rock' }] }, entities = [{ x: 1 }];
    const firstWire = encoder.encode('connection1', snapshot({ map, entities }), ['map']);
    expect(firstWire).toMatchObject({ type: STATIC_VIEW_TRANSFER, revision: 1, fields: { map } });
    const first = decoder.decode('connection1', structuredClone(firstWire)) as Snapshot;
    entities[0].x = 2;
    const secondWire = encoder.encode('connection1', snapshot({ map, entities }, { snapshotSeq: 2 }), ['map']);
    expect(secondWire).not.toHaveProperty('fields'); expect(secondWire).not.toHaveProperty('snapshot.view.map');
    const second = decoder.decode('connection1', structuredClone(secondWire)) as Snapshot;
    expect(second.view).toEqual({ map, entities: [{ x: 2 }] });
    expect((first.view as { entities: { x: number }[] }).entities[0].x).toBe(1);
    expect((second.view as { map: unknown }).map).toBe((first.view as { map: unknown }).map);
    expect((second.view as { map: unknown }).map).not.toBe(map);
  });
  it('isolates every observer and invalidates cache across epoch, controller, and declared object changes', () => {
    const encoder = new SnapshotEncoder(), decoder = new SnapshotDecoder();
    const publicMap = { sectors: ['north'] }, otherMap = { sectors: ['south'] };
    const deliver = (id: string, value: Snapshot) => decoder.decode(id, structuredClone(encoder.encode(id, value, ['map']))) as Snapshot;
    const first = deliver('one', snapshot({ map: publicMap }));
    const other = deliver('two', snapshot({ map: otherMap }, { participantId: 'observer2' }));
    expect(other.view).toEqual({ map: otherMap }); expect(first.view).toEqual({ map: publicMap });
    for (const changes of [{ epoch: 2 }, { epoch: 2, controllerGeneration: 3 }, { epoch: 2, controllerGeneration: 3, participantId: 'observer2' }]) {
      const wire = encoder.encode('one', snapshot({ map: publicMap }, changes), ['map']);
      expect(wire).toHaveProperty('fields'); decoder.decode('one', structuredClone(wire));
    }
    const replacement = encoder.encode('one', snapshot({ map: otherMap }), ['map']);
    expect(replacement).toHaveProperty('fields.map', otherMap);
    const omitted = encoder.encode('one', snapshot({ entities: [] }), ['map']);
    expect(omitted).toHaveProperty('fields', {});
    expect((decoder.decode('one', structuredClone(omitted)) as Snapshot).view).toEqual({ entities: [] });
  });
  it('fails closed when an observer or scope has no baseline, and accepts old worker snapshots', () => {
    const encoder = new SnapshotEncoder(), decoder = new SnapshotDecoder(), map = { ground: true };
    const value = snapshot({ map });
    decoder.decode('one', structuredClone(encoder.encode('one', value, ['map'])));
    const compact = structuredClone(encoder.encode('one', value, ['map']));
    expect(() => decoder.decode('other', compact)).toThrow('SNAPSHOT_TRANSFER_BASELINE_MISSING');
    expect(() => decoder.decode('one', { ...compact, snapshot: { ...value, epoch: 8 } })).toThrow('SNAPSHOT_TRANSFER_BASELINE_MISSING');
    expect(decoder.decode('one', value)).toBe(value);
    expect(() => decoder.decode('one', compact)).toThrow('SNAPSHOT_TRANSFER_BASELINE_MISSING');
    encoder.delete('one');
    expect(encoder.encode('one', value, ['map'])).toHaveProperty('fields');
    expect(encoder.encode('legacy', value, [])).toBe(value);
  });
  it('bounds its connections, clears retained references, and rejects unsafe field declarations', () => {
    const encoder = new SnapshotEncoder(), decoder = new SnapshotDecoder(), value = snapshot({ map: { ground: true } });
    for (let index = 0; index < 256; index++) decoder.decode(`c${index}`, structuredClone(encoder.encode(`c${index}`, value, ['map'])));
    expect(encoder.encode('overflow', value, ['map'])).toBe(value);
    encoder.delete('c0'); decoder.delete('c0');
    expect(encoder.encode('replacement', value, ['map'])).toHaveProperty('fields');
    encoder.clear(); decoder.clear();
    expect(encoder.encode('new', value, ['map'])).toHaveProperty('fields');
    for (const keys of [['constructor'], ['__proto__'], ['map', 'map']]) expect(() => encoder.encode('bad', value, keys)).toThrow('INVALID_STATIC_VIEW_FIELDS');
    expect(() => decoder.decode('bad', { type: STATIC_VIEW_TRANSFER, snapshot: value, revision: 1, fields: JSON.parse('{"__proto__":{}}') })).toThrow('INVALID_SNAPSHOT_TRANSFER');
    expect(snapshotConnection('connect', [{}, 'connection'])).toBe('connection');
    expect(snapshotConnection('snapshot', ['connection'])).toBe('connection');
    expect(snapshotConnection('action', ['connection'])).toBeUndefined();
  });
});
