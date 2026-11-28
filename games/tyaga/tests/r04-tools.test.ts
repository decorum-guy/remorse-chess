import RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT } from '../src/core/config';
import { clamp, distance, length, localPoint, norm, sub, V } from '../src/core/math';
import { TyagaWorld } from '../src/server-world/world';
import { evidence } from './evidence';

import { attachBase, cableAction, kineticState, observedWinchFixture, participants, steps } from './r04-fixtures';

describe('R04 ordinary UI mechanism defects (observed-geometry fixtures)', () => {
  it.each([false, true])('accepts the same clear winch base strap in either endpoint order: reverse=%s', async reverse => {
    const w = await observedWinchFixture();
    try {
      const result = attachBase(w, reverse);
      evidence(`R04-winch-strap-order-${reverse}`, { result, from: w.socket(reverse ? 'training-anchor' : 'winch-1', reverse ? 'ring' : 'base'), to: w.socket(reverse ? 'winch-1' : 'training-anchor', reverse ? 'base' : 'ring') });
      expect(result.result.ok).toBe(true); expect(w.state.inventory['strap-11'].state).toBe('attached');
    } finally { w.dispose(); }
  });

  it('rejects the observed initial cable through its own source housing before creating any cable body', async () => {
    const w = await observedWinchFixture();
    try {
      expect(attachBase(w).result.ok).toBe(true);
      const from = w.socket('winch-1', 'drum')!.world, to = w.socket('training-light', 'ring-1-1')!.world;
      const ray = new RAPIER.Ray(from, norm(sub(to, from))), hits: { id: string; distance: number }[] = [];
      w.physics.intersectionsWithRay(ray, distance(from, to), true, hit => { hits.push({ id: w.state.colliderBodies[hit.collider.handle], distance: hit.timeOfImpact }); return true; });
      const result = w.action('alice', cableAction);
      evidence('R04-rope-source-housing', { from, to, hits, result });
      expect(hits.some(hit => hit.id === 'winch-1')).toBe(true);
      expect(result.result.ok).toBe(false); expect(result.result.code).toBe('ROPE_BLOCKED');
      expect(Object.values(w.state.links).some(link => link.kind === 'rope')).toBe(false);
      expect(Object.values(w.state.entities).some(entity => entity.kind === 'rope-segment')).toBe(false);
    } finally { w.dispose(); }
  });

  it('reels a physically clear 17m cable toward a secured portable winch without ejecting either body', async () => {
    const w = await observedWinchFixture(true);
    try {
      expect(attachBase(w).result.ok).toBe(true); expect(w.action('alice', cableAction).result.ok).toBe(true); steps(w, 120);
      const link = Object.values(w.state.links).find(candidate => candidate.kind === 'rope')!;
      const initialWinch = { ...w.body('winch-1').translation() }, initialLoad = { ...w.body('training-light').translation() }, initialLength = link.length;
      let peakLoadSpeed = 0, peakWinchSpeed = 0; const history = [];
      for (let i = 0; i < 132; i++) {
        steps(w, 1, 1); peakLoadSpeed = Math.max(peakLoadSpeed, length(w.body('training-light').linvel())); peakWinchSpeed = Math.max(peakWinchSpeed, length(w.body('winch-1').linvel()));
        if (i % 6 === 0) history.push({ i, ropeLength: link.length, tension: link.tension, winch: { ...w.body('winch-1').translation() }, load: { ...w.body('training-light').translation() } });
      }
      const ids=['winch-1','training-light',link.hookId!,link.collarId!,...link.segments!.map(s=>s.id)],beforeRelease=kineticState(w,ids);
      expect(w.action('alice',{type:'release'}).result.ok).toBe(true);
      const afterRelease=kineticState(w,ids);expect(afterRelease).toEqual(beforeRelease);
      for(let i=0;i<120;i++){steps(w,1);peakLoadSpeed=Math.max(peakLoadSpeed,length(w.body('training-light').linvel()));peakWinchSpeed=Math.max(peakWinchSpeed,length(w.body('winch-1').linvel()));}
      evidence('R04-clear-long-cable', { initialWinch, initialLoad, initialLength, finalLength: link.length, peakLoadSpeed, peakWinchSpeed, beforeRelease,afterRelease,energyAfterHold:kineticState(w,ids).energy,finalWinch: { ...w.body('winch-1').translation() }, finalLoad: { ...w.body('training-light').translation() }, history, events: w.state.events });
      expect(w.state.entities['training-anchor'].anchored).toBe(true);
      expect(w.state.links[link.id].broken).toBe(false);
      expect(w.state.inventory['strap-11'].state).toBe('attached');
      expect(peakLoadSpeed).toBeLessThan(5); expect(peakWinchSpeed).toBeLessThan(2);
      expect(distance(initialWinch, w.body('winch-1').translation())).toBeLessThan(.5);
      expect(link.length).toBeLessThan(initialLength - .3);
    } finally { w.dispose(); }
  });

  it('lets the observed aligned deck rest on the actual supports and attach at two opposite ends', async () => {
    const w = await TyagaWorld.create({ matchId: 'R04-mounts', mapId: 'tutorial', participants });
    try {
      w.body('training-heavy').setTranslation(V(35.57236099243164, 1.3, 27.91473388671875), true);
      w.body('training-heavy').setRotation({ x: -2.538417618325184e-7, y: -.007710810285061598, z: -3.9037278298792444e-8, w: .9999703168869019 }, true);
      w.body('person:alice').setTranslation(V(35.98, .875, 30), true);
      w.body('person:bob').setTranslation(V(35.5, .875, 25.9), true);
      steps(w, 180);
      const initialRest = { ...w.body('training-heavy').translation() };
      const phases: unknown[] = []; const phase = (name: string) => phases.push({ name, tick: w.state.tick, deck: { ...w.body('training-heavy').translation() }, people: Object.values(w.state.characters).map(c => ({ holding: structuredClone(c.holding), position: { ...w.body(c.bodyId).translation() } })) });
      expect(w.action('alice', { type: 'grab', itemId: 'training-heavy', handleId: 'handle-1' }).result.ok).toBe(true);
      expect(w.action('bob', { type: 'grab', itemId: 'training-heavy', handleId: 'handle-0' }).result.ok).toBe(true);
      for (let i = 0; i < 100; i++) w.step({ alice: { ...NEUTRAL_INPUT, tool: 1 }, bob: { ...NEUTRAL_INPUT, tool: 1 } });
      phase('raised');
      // Correct the same R04 horizontal placement by finite shared hand forces.
      // No transform or velocity assignment follows the initial fixture setup.
      for (let pulse = 0; pulse < 20; pulse++) {
        const p = w.body('training-heavy').translation(), dx = 35.5 - p.x, dz = 28 - p.z;
        if (Math.hypot(dx, dz) < .025) break;
        const moveX = Math.abs(dx) > .02 ? Math.sign(dx) : 0, moveZ = Math.abs(dz) > .02 ? Math.sign(dz) : 0;
        for (let i = 0; i < 4; i++) w.step({ alice: { ...NEUTRAL_INPUT, moveX, moveZ }, bob: { ...NEUTRAL_INPUT, moveX, moveZ } });
        for (let i = 0; i < 20; i++) w.step({ alice: { ...NEUTRAL_INPUT }, bob: { ...NEUTRAL_INPUT } });
      }
      phase('corrected');
      for (let i = 0; i < 140; i++) w.step({ alice: { ...NEUTRAL_INPUT, tool: -1 }, bob: { ...NEUTRAL_INPUT, tool: -1 } });
      expect(w.action('alice', { type: 'release' }).result.ok).toBe(true); expect(w.action('bob', { type: 'release' }).result.ok).toBe(true); steps(w, 90);
      const pairs = [['alice', 'ring-1-1', 'training-bridge-mount-35.5-1-1'], ['bob', 'ring--1--1', 'training-bridge-mount-35.5--1--1']];
      const gaps = pairs.map(([, from, to]) => ({ from, to, gap: distance(w.socket('training-heavy', from)!.world, w.socket(to, 'ring')!.world) }));
      evidence('R04-deck-mount-clearance', { initialRest, deck: { ...w.body('training-heavy').translation() }, mass: w.body('training-heavy').mass(), gaps, holders: Object.values(w.state.characters).map(c => c.holding), phases, events: w.state.events });
      expect(gaps.every(pair => pair.gap <= .3)).toBe(true);
      expect(w.body('training-heavy').mass()).toBeCloseTo(110, 4);
      for (let i = 0; i < 180; i++) {
        const a = w.body('person:alice').translation(), b = w.body('person:bob').translation();
        w.step({ alice: { ...NEUTRAL_INPUT, moveX: clamp((37.4 - a.x) * 2, -.6, .6), moveZ: clamp((30.1 - a.z) * 2, -.6, .6) }, bob: { ...NEUTRAL_INPUT, moveX: clamp((33.7 - b.x) * 2, -.6, .6), moveZ: clamp((25.9 - b.z) * 2, -.6, .6) } });
      }
      for (const [participantId, fromSocket, toId] of pairs) {
        const result=w.action(participantId, { type: 'attach', kind: 'deck', fromId: 'training-heavy', fromSocket, toId, toSocket: 'ring' });
        const contacts:unknown[]=[];
        for(const h of w.state.entities['training-heavy'].colliders){const collider=w.physics.getCollider(h);w.physics.contactPairsWith(collider,other=>w.physics.contactPair(collider,other,(m,flipped)=>{for(let i=0;i<m.numSolverContacts();i++){const point=m.solverContactPoint(i);contacts.push({other:w.state.colliderBodies[other.handle],normal:m.normal(),flipped,dist:m.solverContactDist(i),point,local:point?localPoint(w.body('training-heavy').translation(),w.body('training-heavy').rotation(),point):null});}}));}
        evidence(`R04-deck-attach-${participantId}`, {result:result.result, actor:{...w.body(`person:${participantId}`).translation()}, deck:{...w.body('training-heavy').translation()}, rotation:{...w.body('training-heavy').rotation()}, from:w.socket('training-heavy',fromSocket),to:w.socket(toId,'ring'),contacts});
        expect(result.result.ok).toBe(true); steps(w, 65);
      }
      expect(Object.values(w.state.links).filter(link => link.kind === 'deck' && !link.broken)).toHaveLength(2);
      steps(w, 120);
      evidence('R04-deck-mounted', { deck: { ...w.body('training-heavy').translation() }, rotation: { ...w.body('training-heavy').rotation() }, speed: length(w.body('training-heavy').linvel()), links: Object.values(w.state.links).filter(link => link.kind === 'deck') });
      expect(w.body('training-heavy').translation().y).toBeLessThan(.12);
      expect(length(w.body('training-heavy').linvel())).toBeLessThan(.1);
    } finally { w.dispose(); }
  });
});
