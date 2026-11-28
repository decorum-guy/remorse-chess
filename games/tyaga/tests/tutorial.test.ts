import { describe, expect, it } from 'vitest';
import { NEUTRAL_INPUT } from '../src/core/config';
import { length, V } from '../src/core/math';
import { advanceTutorial } from '../src/tutorial';
import { TyagaWorld } from '../src/server-world/world';
import { evidence } from './evidence';
import { attachBase, cableAction, observedWinchFixture, participants, steps } from './r04-fixtures';

function lesson(w: TyagaWorld, step: number) {
  // This is a lesson-predicate fixture, never a gameplay completion helper.
  w.state.tutorial = { step, completed: false, flags: {}, stepStartPosition: { ...w.body('person:alice').translation() }, stepStartedAt: w.state.tick, checkpointDone: false };
}

async function pullingLesson() {
  const w = await observedWinchFixture(true);
  expect(attachBase(w).result.ok).toBe(true); lesson(w, 5);
  expect(w.action('alice', cableAction).result.ok).toBe(true); steps(w, 120);
  const rope = Object.values(w.state.links).find(l => l.kind === 'rope')!;
  steps(w, 90, 1);
  expect(w.state.tutorial.step).toBe(5);
  expect(Object.keys(w.state.tutorial.flags).some(key => key.endsWith(':pulled'))).toBe(true);
  return { w, rope };
}

describe('tutorial conditions match the stated physical work', () => {
  it.each(['neutral', 'release'] as const)('accepts an intentional %s after a real secured pull', async stop => {
    const { w, rope } = await pullingLesson();
    try {
      if (stop === 'release') expect(w.action('alice', { type: 'release' }).result.ok).toBe(true);
      steps(w, 35);
      evidence(`R04-tutorial-safe-winch-${stop}`, { ropeLength: rope.length, tension: rope.tension, anchored: w.state.entities['training-anchor'].anchored, tutorial: w.state.tutorial, events: w.state.events });
      expect(w.state.tutorial.step).toBe(6); expect(w.state.entities['training-anchor'].anchored).toBe(true);
    } finally { w.dispose(); }
  });

  it.each(['automatic-release', 'broken-base', 'disconnected', 'takeover', 'rescue-after-release'] as const)('does not pass a pull interrupted by %s', async interruption => {
    const { w } = await pullingLesson();
    try {
      if (interruption === 'automatic-release') w.releaseCharacter('alice');
      if (interruption === 'rescue-after-release') {expect(w.action('alice',{type:'release'}).result.ok).toBe(true);w.beginRescue('alice');}
      if (interruption === 'broken-base') w.detachLink(Object.values(w.state.links).find(l => l.itemId === 'strap-11')!.id, true);
      if (interruption === 'disconnected') w.setControllers([{ participantId: 'alice', kind: 'human', connected: false, controllerGeneration: 1 }, { participantId: 'bob', kind: 'human', connected: true, controllerGeneration: 0 }]);
      if (interruption === 'takeover') w.setControllers([{ participantId: 'alice', kind: 'bot', connected: false, controllerGeneration: 1 }, { participantId: 'bob', kind: 'human', connected: true, controllerGeneration: 0 }]);
      steps(w, 45);
      evidence(`R04-tutorial-invalid-stop-${interruption}`, { tutorial: w.state.tutorial, events: w.state.events });
      expect(w.state.tutorial.step).toBe(5);
    } finally { w.dispose(); }
  });

  it('does not credit an unrelated installed anchor when the winch base has no strap', async () => {
    const w = await observedWinchFixture(true);
    try {
      lesson(w, 5); expect(w.action('alice', cableAction).result.ok).toBe(true); steps(w, 120); steps(w, 90, 1); steps(w, 60);
      expect(w.state.tutorial.step).toBe(5);
    } finally { w.dispose(); }
  });

  it('requires two restored small-cargo straps to lead to the truck', async () => {
    const w = await TyagaWorld.create({ matchId: 'tutorial-straps', mapId: 'tutorial', participants });
    try {
      lesson(w, 3);
      const links = Object.values(w.state.links).filter(l => l.fromId === 'cargo-2' && l.kind === 'strap');
      for (const link of links) { w.state.tutorial.flags[`secured:${link.itemId}`] = 1; link.toId = 'training-anchor'; link.toSocket = 'ring'; }
      advanceTutorial(w); expect(w.state.tutorial.step).toBe(3);
      for (const link of links) { link.toId = 'truck'; link.toSocket = 'ring-3--1'; }
      advanceTutorial(w); expect(w.state.tutorial.step).toBe(4);
    } finally { w.dispose(); }
  });

  it('does not call lateral truck motion a stop and still accepts the real driven climb', async () => {
    const w = await TyagaWorld.create({ matchId: 'tutorial-slope', mapId: 'tutorial', participants });
    let disposed = false;
    try {
      lesson(w, 4);
      // The old predicate ignored vz completely. This separate initial
      // boundary fixture supplies genuine velocity, not a victory state.
      const snapshot = w.serialize();
      w.body('truck').setTranslation(V(32, 2.49, 18), true); w.body('truck').setLinvel(V(0, 0, 2), true);
      w.state.tutorial.flags['climb-start-y'] = .99; w.state.tutorial.flags['climb-driven'] = 1;
      advanceTutorial(w); expect(w.state.tutorial.step).toBe(4);
      w.dispose(); disposed = true;
      const driven = await TyagaWorld.restore(snapshot);
      try {
        driven.body('person:alice').setTranslation(V(15, .875, 20.2), true); driven.step();
        expect(driven.action('alice', { type: 'operate', targetId: 'truck' }).result.ok).toBe(true);
        let reached = false;
        for (let i = 0; i < 1500; i++) {
          if (driven.body('truck').translation().x > 31.5) { reached = true; break; }
          driven.step({ alice: { ...NEUTRAL_INPUT, throttle: 1 } });
        }
        expect(reached).toBe(true);
        for (let i = 0; i < 180; i++) driven.step({ alice: { ...NEUTRAL_INPUT, brake: true } });
        evidence('R04-tutorial-driven-climb', { position: { ...driven.body('truck').translation() }, speed: length(driven.body('truck').linvel()), tutorial: driven.state.tutorial });
        expect(driven.state.tutorial.step).toBe(5);
      } finally { driven.dispose(); }
    } finally { if (!disposed) w.dispose(); }
  });

  it('requires two supported ends of the training deck, not two attachments on one end', async () => {
    const w = await TyagaWorld.create({ matchId: 'tutorial-deck', mapId: 'tutorial', participants });
    try {
      w.body('training-heavy').setTranslation(V(35.5, .6, 28), true); w.body('training-heavy').setRotation({ x: 0, y: 0, z: 0, w: 1 }, true); steps(w, 180); lesson(w, 6);
      w.addLink('deck', 'training-heavy', 'ring--1--1', 'training-bridge-mount-35.5--1--1', 'ring');
      const redundant = w.addLink('deck', 'training-heavy', 'ring--1-1', 'training-bridge-mount-35.5--1-1', 'ring');
      steps(w, 60); expect(w.state.tutorial.step).toBe(6);
      w.detachLink(redundant.id); w.addLink('deck', 'training-heavy', 'ring-1-1', 'training-bridge-mount-35.5-1-1', 'ring');
      steps(w, 60); expect(w.state.tutorial.step).toBe(7);
    } finally { w.dispose(); }
  });
});
