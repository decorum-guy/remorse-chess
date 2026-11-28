import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deserializeWorld, neutralInput, serializeWorld, stepWorld, viewForPlayer } from '../src/core/index'
import { walkToward } from '../src/core/navigation'
import { isPointVisible, shotEvent, visibleEnemyBuildingIds, withVisibilitySnapshot } from '../src/core/visibility'
import type { Point, Team, World } from '../src/core/types'
import { maxSceneFixtures } from './core-benchmark'

const digest = (value: string | object) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

describe('exact visibility optimization', () => {
  it('keeps an unknown obstacle out of route planning and detours only after observing it', () => {
    const w = maxSceneFixtures()[0], u = w.units.find(unit => unit.ownerId === 'A1' && unit.kind === 'fighter')!
    w.units = w.units.filter(unit => unit.team !== 'A' || unit.id === u.id)
    w.transports = w.transports.filter(t => t.team !== 'A')
    u.x = 30; u.z = 12; u.path = []; u.pathTarget = null
    w.smokes = [{ id: 'hidden-route-cloud', ownerId: 'B1', team: 'B', x: 33, z: 12, radius: 3.5, expiresTick: 2000 }]
    const obstacle = w.buildings.find(b => b.team === 'B' && b.padId === 'R-13')!, goal = { x: 44, z: 12 }
    expect(visibleEnemyBuildingIds(w, 'A').has(obstacle.id)).toBe(false)
    walkToward(w, u, goal, 0.2, 4.5)
    expect(u.path).toEqual([goal])
    expect(viewForPlayer(w, 'A1').buildings.some(b => b.id === obstacle.id)).toBe(false)
    w.smokes = []; u.path = []; u.pathTarget = null
    expect(visibleEnemyBuildingIds(w, 'A').has(obstacle.id)).toBe(true)
    walkToward(w, u, goal, 0.2, 4.5)
    expect(u.path.length).toBeGreaterThan(1)
    expect(u.path[u.path.length - 1]).toEqual(goal)
  })

  it('matches direct LOS at tracer cells, smoke and range boundaries, then discards changed occluders', () => {
    let seed = 16767
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000 }
    for (const initial of maxSceneFixtures()) {
      let w = initial
      const source = w.units.find(u => u.ownerId === 'A1' && u.kind === 'fighter')!
      if (w.smokes[0]) { source.x = w.smokes[0].x; source.z = w.smokes[0].z }
      const points: Point[] = []
      for (let i = 0; i < 350; i++) points.push({ x: -20 + random() * 104, z: -20 + random() * 80 })
      for (const edge of [1.5, 3.5, 6, 8, 14, 18]) for (const epsilon of [-1e-10, 0, 1e-10]) {
        points.push({ x: source.x + edge + epsilon, z: source.z }, { x: source.x, z: source.z - edge - epsilon })
      }
      for (let x = -4; x <= 68; x += 4) for (const epsilon of [-1e-10, 0, 1e-10]) points.push({ x: x + epsilon, z: 20 + epsilon })
      const targets = [undefined, source.id, w.buildings[0].id, w.buildings[3].id, ...w.smokes.map(s => s.id)]
      const queries = points.map((point, i) => ({ point, targetId: targets[i % targets.length] }))
      const check = () => {
        const direct = (['A', 'B'] as Team[]).map(team => queries.map(q => isPointVisible(w, team, q.point, q.targetId)))
        const accelerated = withVisibilitySnapshot(w, () => {
          // A real tracer enables the acceleration structure; event emission changes no geometry.
          shotEvent(w, source, { x: source.x + 34, z: source.z + 3 }, 'test')
          return (['A', 'B'] as Team[]).map(team => queries.map(q => isPointVisible(w, team, q.point, q.targetId)))
        })
        expect(accelerated).toEqual(direct)
      }
      check()
      // Mutations at the same tick must be observed by the next scope, not a tick-keyed cache.
      w.smokes = []; w.barriers = []; w.buildings.shift()
      for (const wall of w.walls) if (wall.destructible) wall.hp = 0
      for (const building of w.buildings) building.powered = !building.powered
      source.x += 7; check()
      w = deserializeWorld(serializeWorld(w)); check()
    }
  })

  it('preserves frozen baseline world and six safe views through firing, expiry and save/load', () => {
    // Captured from the archived unoptimized core 22a7132d…, using these exact input fixtures.
    // The comparison covers every authoritative field and viewer-local event, not only match scores.
    const golden = [
      ['75df9d81776a366d9014b525d09705b4a0d2b5033f86a3423f8376ce1f8d3328', '5af6f5b55bbf9854e3bfc05f6d9184aca37140fb6bb2c90c0e3da5bbca97f690', 'c0f218753f354f597f1f5e10a6b7d533073aca68b9cc87097ea5df63b3f86cc5'],
      ['5d622877845eb2992187f12c7f79982855a40f05c2e72a65f8a2df5b62c6ec53', 'd3305dd7cffa4307ae0a3ebcafbfa7f998e80c3a50d390dbd6bdc6f601adefdc', 'ccd854808958b5cf2b4846013d3b0a9d1ebd03bb7c455238023779effbdedc0d'],
      ['9f653924629b6024ce8943a30092f961017b61e3c82aaeef65fa7a5659aeaa6e', '00f55317b63114ec1f62b3f9ef290049b810392b85e9528a532127eadfe963bf', '1e8abbd2b1bcb70a2082e20ccc10a104d06176f2860f4cacddfadd3cdc4b74da'],
    ]
    for (const [index, fixture] of maxSceneFixtures().entries()) {
      let w: World = fixture
      const inputs = Object.fromEntries(w.participants.map(p => [p.id, { ...neutralInput(), fireHeld: true, aimX: p.team === 'A' ? 1 : -1 }]))
      for (let step = 1; step <= 240; step++) {
        stepWorld(w, inputs)
        if (step === 1) expect(digest(serializeWorld(w))).toBe(golden[index][0])
        if (step === 90) w = deserializeWorld(serializeWorld(w))
      }
      expect(digest(serializeWorld(w))).toBe(golden[index][1])
      expect(digest(w.participants.map(p => viewForPlayer(w, p.id)))).toBe(golden[index][2])
    }
  }, 30000)
})
