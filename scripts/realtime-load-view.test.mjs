import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLoadChanges } from './realtime-load-view.mjs';

test('shares only the unchanged map and still deep-clones all dynamic body/inventory data', () => {
  const baseline = { map: { ground: [{ x: 1 }] }, entities: [{ position: { x: 2 }, velocity: { x: 3 } }], inventory: [{ id: 'beam' }] };
  const projected = applyLoadChanges(baseline, [{ path: ['entities', 0, 'position', 'x'], value: 9 }]);
  assert.equal(projected.map, baseline.map);
  assert.notEqual(projected.entities, baseline.entities); assert.notEqual(projected.entities[0].velocity, baseline.entities[0].velocity);
  assert.notEqual(projected.inventory, baseline.inventory);
  assert.equal(baseline.entities[0].position.x, 2); assert.equal(projected.entities[0].position.x, 9);
  projected.inventory[0].id = 'deck'; assert.equal(baseline.inventory[0].id, 'beam');
});
test('a real map update, removal or full replacement leaves older baselines untouched', () => {
  const baseline = { map: { ground: [{ x: 1 }], route: 'A' }, value: 4 };
  const projected = applyLoadChanges(baseline, [{ path: ['map', 'ground', 0, 'x'], value: 7 }, { path: ['map', 'route'], remove: true }]);
  assert.notEqual(projected.map, baseline.map); assert.equal(baseline.map.ground[0].x, 1); assert.equal(projected.map.ground[0].x, 7);
  assert.equal(baseline.map.route, 'A'); assert.equal(projected.map.route, undefined);
  const replacement = { map: { route: 'B' } }, full = applyLoadChanges(baseline, [{ path: [], value: replacement }]);
  assert.deepEqual(full, replacement); assert.notEqual(full, replacement); assert.notEqual(full.map, replacement.map);
});
test('rejects unsafe or absent delta paths and applies ordinary non-map projections', () => {
  for (const path of [['__proto__', 'bad'], ['map', 'constructor'], ['absent', 'child']]) assert.throws(() => applyLoadChanges({ map: {} }, [{ path, value: 1 }]), /INVALID_DELTA/);
  assert.deepEqual(applyLoadChanges([1, 2], [{ path: [1], value: 3 }]), [1, 3]);
});
