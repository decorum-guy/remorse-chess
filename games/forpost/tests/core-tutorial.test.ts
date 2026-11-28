import { describe, expect, it } from 'vitest'
import { advanceWorld, applyAction, createTutorialWorld, deserializeWorld, neutralInput, serializeWorld, stepWorld, tutorialProgress } from '../src/core/index'
import { distance, normalize } from '../src/core/geometry'
import { fighter } from '../src/core/state'
import type { Point, World } from '../src/core/types'

function walk(w: World, point: Point, limit = 900): void {
  for (let i = 0; i < limit; i++) {
    const u = fighter(w, 'learner')!
    if (distance(u, point) < 0.2) { stepWorld(w, { learner: neutralInput() }); return }
    const d = normalize(point.x - u.x, point.z - u.z)
    stepWorld(w, { learner: { ...neutralInput(), moveX: d.x, moveZ: d.z } })
  }
  throw new Error(`walk did not reach ${JSON.stringify(point)}`)
}
function until(w: World, condition: () => boolean, limit = 3000): void {
  for (let i = 0; i < limit && !condition(); i++) stepWorld(w)
  expect(condition()).toBe(true)
}
describe('seven real-command tutorial exercises', () => {
  it('requires both movement marks, a real hit and finished reload', () => {
    const w = createTutorialWorld(0)
    applyAction(w, 'learner', { type: 'reload' }); advanceWorld(w, 10); expect(tutorialProgress(w).stage).toBe(0)
    walk(w, { x: 12, z: 18 }); expect(tutorialProgress(w).stage).toBe(1)
    walk(w, { x: 12, z: 22 }); expect(tutorialProgress(w).stage).toBe(2)
    stepWorld(w, { learner: { ...neutralInput(), aimX: 1, aimZ: 0, firePressSeq: 1 } }); expect(tutorialProgress(w).stage).toBe(3)
    expect(applyAction(w, 'learner', { type: 'reload' }).ok).toBe(true); advanceWorld(w, 60); expect(tutorialProgress(w).completed).toBe(true)
  })
  it('requires actual wall blocking, traversing its side and a valid tool', () => {
    const w = createTutorialWorld(1)
    stepWorld(w, { learner: { ...neutralInput(), firePressSeq: 1 } }); expect(tutorialProgress(w).stage).toBe(1)
    walk(w, { x: 17, z: 20 }); walk(w, { x: 20.6, z: 20 }); expect(tutorialProgress(w).stage).toBe(2)
    expect(applyAction(w, 'learner', { type: 'tool' }).ok).toBe(true); stepWorld(w); expect(tutorialProgress(w).completed).toBe(true)
  })
  it('escorts the actual transport, clears the contest and completes the real unload', () => {
    const w = createTutorialWorld(2); stepWorld(w)
    for (let i = 0; i < 600 && tutorialProgress(w).stage < 2; i++) {
      const u = fighter(w, 'learner')!, t = w.transports.find(t => t.team === 'A')!
      const d = normalize(t.x - u.x, t.z - u.z)
      stepWorld(w, { learner: { ...neutralInput(), moveX: distance(u, t) > 1.4 ? d.x : 0, moveZ: distance(u, t) > 1.4 ? d.z : 0 } })
    }
    expect(tutorialProgress(w).stage).toBe(2)
    for (let i = 0; i < 90 && fighter(w, 'training-target'); i++) {
      const u = fighter(w, 'learner')!, target = fighter(w, 'training-target')!, aim = normalize(target.x - u.x, target.z - u.z)
      stepWorld(w, { learner: { ...neutralInput(), aimX: aim.x, aimZ: aim.z, fireHeld: true } })
    }
    until(w, () => tutorialProgress(w).completed, 150)
    expect(w.teams.A.deliveries).toBe(1)
  })
  it('spends 180 and waits for builder work and real increased income', () => {
    const w = createTutorialWorld(3)
    expect(applyAction(w, 'learner', { type: 'build', kind: 'relay', padId: 'L-03' }).ok).toBe(true)
    expect(applyAction(w, 'learner', { type: 'build', kind: 'extractor', padId: 'L-01' }).ok).toBe(true)
    expect(w.participants[0].credits).toBe(40)
    until(w, () => tutorialProgress(w).completed)
    expect(w.buildings.find(b => b.kind === 'extractor')?.powered).toBe(true)
  })
  it('resolves overload by priority and then a connected real generator', () => {
    const w = createTutorialWorld(4), battery = w.buildings.find(b => b.kind === 'battery')!, extractor = w.buildings.find(b => b.kind === 'extractor')!
    expect(battery.powered).toBe(false)
    applyAction(w, 'learner', { type: 'priority', buildingIds: [battery.id] }); stepWorld(w); expect(tutorialProgress(w).stage).toBe(1)
    applyAction(w, 'learner', { type: 'sell', buildingId: extractor.id }); advanceWorld(w, 60)
    expect(applyAction(w, 'learner', { type: 'build', padId: extractor.padId, kind: 'generator' }).ok).toBe(true)
    until(w, () => tutorialProgress(w).completed)
    expect(w.participants[0].power).toBe(10)
  })
  it('requires actual drone production, tactical escort and return to direct control', () => {
    const w = createTutorialWorld(5), dock = w.buildings.find(b => b.kind === 'dock')!
    applyAction(w, 'learner', { type: 'produceDrone', buildingId: dock.id }); until(w, () => tutorialProgress(w).stage === 2, 300)
    applyAction(w, 'learner', { type: 'mode', mode: 'tactics' }); stepWorld(w)
    const drone = w.units.find(u => u.kind === 'drone')!
    applyAction(w, 'learner', { type: 'order', unitIds: [drone.id], order: { type: 'escort' } }); until(w, () => tutorialProgress(w).stage === 4, 1800)
    applyAction(w, 'learner', { type: 'mode', mode: 'fighter' }); stepWorld(w); expect(tutorialProgress(w).completed).toBe(true); expect(drone.order.type).toBe('escort')
  })
  it('finishes the short operation by real delivery and saves/restores lesson state separately', () => {
    const w = createTutorialWorld(6)
    applyAction(w, 'learner', { type: 'mode', mode: 'tactics' }); applyAction(w, 'learner', { type: 'order', unitIds: ['fighter:learner'], order: { type: 'escort' } })
    advanceWorld(w, 100); const restored = deserializeWorld(serializeWorld(w)); expect(tutorialProgress(restored)).toEqual(tutorialProgress(w))
    until(restored, () => tutorialProgress(restored).completed, 1200); expect(restored.phase).toBe('finished'); expect(restored.teams.A.deliveries).toBeGreaterThan(0)
  })
})
