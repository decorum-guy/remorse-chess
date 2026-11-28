import RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, it } from 'vitest';
import { add, distance, norm, sub, V } from '../src/core/math';
import { TyagaWorld } from '../src/server-world/world';
import { evidence } from './evidence';

async function detachedSmallCargoFixture() {
  const w = await TyagaWorld.create({ matchId: 'R04-strap-reach', mapId: 'tutorial', participants: [
    { participantId: 'alice', displayName: 'Alice', seatIndex: 0, bot: false },
    { participantId: 'bob', displayName: 'Bob', seatIndex: 1, bot: false },
  ] });
  // Actual R04 standing position; only the initial test fixture is positioned.
  w.body('person:alice').setTranslation(V(14.075775, .874966, 16.006678), true);
  w.step();
  for (const connectionId of ['link-5', 'link-6']) {
    expect(w.action('alice', { type: 'detach', connectionId }).result.ok).toBe(true);
    for (let i = 0; i < 130; i++) w.step();
  }
  return w;
}

function reachBlocker(w: TyagaWorld, socketId: string) {
  const actor = w.body('person:alice'), chest = add(actor.translation(), V(0, .25, 0));
  const target = w.socket('cargo-2', socketId)!.world;
  const ray = new RAPIER.Ray(chest, norm(sub(target, chest)));
  const hit = w.physics.castRay(ray, distance(chest, target) - .08, true, undefined, undefined, undefined, actor, collider => {
    const id = w.state.colliderBodies[collider.handle];
    return (collider.collisionGroups() & 0xffff) !== 0 && id !== 'cargo-2' && id !== 'person:alice' && !id?.startsWith('rope:');
  });
  return hit ? { id: w.state.colliderBodies[hit.collider.handle], distance: hit.timeOfImpact } : null;
}

describe('R04 consumed strap reach (isolated regression, not browser acceptance)', () => {
  it('reinstalls both detached original straps from the cargo side', async () => {
    const w = await detachedSmallCargoFixture();
    try {
      const blocker = reachBlocker(w, 'ring--1--1');
      expect(blocker?.id).toBe('strap-5');
      const results = [];
      for (const [itemId, fromSocket] of [['strap-5', 'ring--1--1'], ['strap-6', 'ring-1--1']]) {
        const action = w.action('alice', { type: 'attach', kind: 'strap', fromId: 'cargo-2', fromSocket, toId: 'truck', toSocket: 'ring-3--1', itemId });
        results.push(action);
        expect(action.result.ok).toBe(true);
        for (let i = 0; i < 130; i++) w.step();
        expect(w.state.inventory[itemId].state).toBe('attached');
      }
      evidence('R04-consumed-strap-reach', { blocker, results, connections: w.view('alice').connections.filter(link => link.itemId === 'strap-5' || link.itemId === 'strap-6') });
    } finally { w.dispose(); }
  });

  it('keeps the other loose strap as a real obstruction', async () => {
    const w = await detachedSmallCargoFixture();
    try {
      const action = w.action('alice', { type: 'attach', kind: 'strap', fromId: 'cargo-2', fromSocket: 'ring--1--1', toId: 'truck', toSocket: 'ring-3--1', itemId: 'strap-6' });
      expect(action.result.code).toBe('BLOCKED');
      expect(w.state.inventory['strap-5'].state).toBe('world');
      expect(w.state.inventory['strap-6'].state).toBe('world');
    } finally { w.dispose(); }
  });
});
