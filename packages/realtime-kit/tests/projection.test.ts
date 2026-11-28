import { describe, expect, it } from 'vitest';
import { applyViewChanges, RealtimeError, viewChanges } from '../src/index.js';

describe('optional immutable top-level client projection', () => {
  const before = () => ({ map: { paths: [{ x: 1, y: 2 }], note: 'before' }, entities: [{ position: { x: 3 }, velocity: { x: 4 } }], inventory: [{ id: 'beam' }] });
  it('keeps existing callers detached and opts in only the immutable map', () => {
    const original = before(), detached = applyViewChanges(original, []) as typeof original;
    expect(detached).toEqual(original); expect(detached.map).not.toBe(original.map); expect(detached.entities).not.toBe(original.entities);
    const projected = applyViewChanges(original, [{ path: ['entities', 0, 'position', 'x'], value: 10 }], ['map']) as typeof original;
    expect(projected.map).toBe(original.map); expect(projected.entities[0].velocity).not.toBe(original.entities[0].velocity);
    expect(projected.inventory).not.toBe(original.inventory); expect(original.entities[0].position.x).toBe(3);
  });
  it('copies retained fields before nested changes, removals, and full replacement', () => {
    const original = before(), expected = before(); expected.map.paths[0] = { x: 7, y: 8 }; delete (expected.map as { note?: string }).note;
    const projected = applyViewChanges(original, viewChanges(original, expected), ['map']);
    expect(projected).toEqual(expected); expect(original).toEqual(before()); expect((projected as typeof original).map).not.toBe(original.map);
    expect(applyViewChanges(original, [{ path: ['map'], remove: true }], ['map'])).toEqual({ entities: original.entities, inventory: original.inventory });
    const replacement = { map: { paths: [] } }, full = applyViewChanges(original, [{ path: [], value: replacement }], ['map']);
    expect(full).toEqual(replacement); expect((full as typeof replacement).map).not.toBe(replacement.map);
  });
  it('rejects prototype paths, inherited traversal and unsafe retention keys', () => {
    for (const path of [['__proto__', 'polluted'], ['map', 'constructor'], ['map', 'prototype'], ['toString', 'polluted'], ['absent', 'child'], [NaN], [-1]]) {
      expect(() => applyViewChanges(before(), [{ path, value: true }], ['map'])).toThrow(RealtimeError);
    }
    expect(() => applyViewChanges(before(), [], ['__proto__'])).toThrow('INVALID_DELTA'); expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('matches deep projection across repeated body changes and occasional map replacements', () => {
    let shared = before(), detached = before();
    for (let index = 0; index < 160; index++) {
      const next = structuredClone(detached); next.entities[0].position.x = index; next.inventory[0].id = String(index);
      if (index % 17 === 0) next.map.paths[0].y = index;
      const delta = viewChanges(detached, next), saved = structuredClone(shared), previous = shared;
      shared = applyViewChanges(shared, delta, ['map']) as typeof shared; detached = applyViewChanges(detached, delta) as typeof detached;
      expect(shared).toEqual(detached); expect(previous).toEqual(saved);
    }
  });
});
