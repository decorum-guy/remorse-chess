import { describe, expect, it } from 'vitest';
import { ProjectionStream } from '../src/projection';
describe('observer scoped full and delta snapshots', () => {
  it('uses an acknowledged baseline, replaces entity arrays on disappearance and sends full every two seconds', () => {
    const stream = new ProjectionStream<{ tick: number; units: { id: string }[] }>();
    const first = stream.snapshot({ tick: 1, units: [{ id: 'visible' }] }, 1, false, 1000);
    expect(first.type).toBe('full'); stream.acknowledge(first.snapshotSeq);
    expect(stream.snapshot({ tick: 2, units: [] }, 1, false, 1067)).toMatchObject({ type: 'delta', baselineSnapshotSeq: first.snapshotSeq, patch: { tick: 2, units: [] } });
    expect(stream.snapshot({ tick: 30, units: [] }, 1, false, 3100).type).toBe('full');
  });
  it('keeps lagging ACKs safe and never accepts an unsent snapshot or another observer baseline', () => {
    const a = new ProjectionStream<{ tick: number; units: string[] }>(), b = new ProjectionStream<{ tick: number; units: string[] }>();
    const first = a.snapshot({ tick: 1, units: ['only-a'] }, 1, false, 1000); a.acknowledge(first.snapshotSeq);
    b.acknowledge(first.snapshotSeq);
    expect(b.snapshot({ tick: 1, units: ['only-b'] }, 1, false, 1000)).toEqual({ type: 'full', snapshotSeq: 1, view: { tick: 1, units: ['only-b'] } });
    const second = a.snapshot({ tick: 2, units: ['only-a'] }, 1, false, 1067);
    const third = a.snapshot({ tick: 3, units: ['only-a'] }, 1, false, 1134);
    expect(second).toMatchObject({ type: 'delta', baselineSnapshotSeq: 1 }); expect(third).toMatchObject({ type: 'delta', baselineSnapshotSeq: 1 });
    a.acknowledge(99); a.acknowledge(second.snapshotSeq); a.acknowledge(first.snapshotSeq);
    expect(a.snapshot({ tick: 4, units: ['only-a'] }, 1, false, 1200)).toMatchObject({ type: 'delta', baselineSnapshotSeq: 2 });
    expect(a.snapshot({ tick: 4, units: [] }, 2, false, 1267).type).toBe('full');
  });
  it('resynchronizes after a stalled queue or an expired baseline', () => {
    const stream = new ProjectionStream<{ tick: number }>();
    stream.acknowledge(stream.snapshot({ tick: 0 }, 1, false, 1000).snapshotSeq);
    for (let tick = 1; tick <= 32; tick++) stream.snapshot({ tick }, 1, false, 1000 + tick);
    expect(stream.snapshot({ tick: 33 }, 1, false, 1033).type).toBe('full');
    stream.reset(); expect(stream.snapshot({ tick: 34 }, 1, false, 1034).type).toBe('full');
  });
});
