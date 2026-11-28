import { describe, expect, it } from 'vitest'
import { createTutorialWorld, getMap, viewForPlayer } from '../src/core/index'
import { visibleContours } from '../src/client/scene'

function fixture() {
  const view = viewForPlayer(createTutorialWorld(0), 'learner')
  view.walls = []; view.smokes = []; view.buildings = []; view.transports = []
  view.units = [view.units.find(unit => unit.kind === 'fighter' && unit.ownerId === view.you)!]
  view.units[0].x = 30; view.units[0].z = 20
  return { view, map: getMap(view.mapId) }
}

describe('rendering contour cache preserves current permitted geometry', () => {
  it('invalidates reused views when a source moves or disappears', () => {
    const { view, map } = fixture(), initial = visibleContours(view, map)
    expect(visibleContours(view, map)).toBe(initial)
    view.units[0].x++
    const moved = visibleContours(view, map)
    expect(moved).not.toBe(initial); expect(moved[1][0].x - initial[1][0].x).toBe(1)
    view.units = []
    expect(visibleContours(view, map)).toHaveLength(1)
  })
  it('changes occlusion when a wall dies, moves or returns, while permanent walls remain opaque', () => {
    const { view, map } = fixture()
    const wall = { ...map.walls[0], x1: 32, x2: 33, z1: 18, z2: 22, destructible: true, hp: 100, maxHp: 100 }
    view.walls = [wall]
    expect(visibleContours(view, map)[1][0].x).toBe(32)
    wall.hp = 0; expect(visibleContours(view, map)[1][0].x).toBeGreaterThan(33)
    wall.hp = 100; wall.x1 = 34; wall.x2 = 35
    expect(visibleContours(view, map)[1][0].x).toBe(34)
    wall.hp = -1; wall.destructible = false
    expect(visibleContours(view, map)[1][0].x).toBe(34)
  })
  it('changes smoke geometry and removes old smoke when the permitted view no longer contains it', () => {
    const { view, map } = fixture()
    view.smokes = [{ id: 'smoke', team: 'A', x: 34, z: 20, radius: 1 }]
    expect(visibleContours(view, map)[1][0].x).toBe(33)
    view.smokes[0].radius = 2
    expect(visibleContours(view, map)[1][0].x).toBe(32)
    view.smokes[0].x = 36
    expect(visibleContours(view, map)[1][0].x).toBe(34)
    view.smokes = []
    expect(visibleContours(view, map)[1][0].x).toBeGreaterThan(34)
  })
  it('recomputes building vision for power changes and clears it when a building leaves the view', () => {
    const { view, map } = fixture(), pad = map.pads.find(p => p.id === 'L-07')!
    view.buildings = [{ id: 'visible-building', ownerId: view.you, team: 'A', kind: 'battery', padId: pad.id, x: pad.x, z: pad.z, hp: 500, maxHp: 500, angle: 0, powered: true, completedTick: 1, suppressed: false }]
    const powered = visibleContours(view, map)
    view.buildings[0].powered = false
    const unpowered = visibleContours(view, map)
    expect(unpowered).not.toBe(powered); expect(unpowered[2][0].x).toBeLessThan(powered[2][0].x)
    view.buildings[0].id = 'replacement-building'
    expect(visibleContours(view, map)).not.toBe(unpowered)
    const replacement = visibleContours(view, map)
    view.buildings[0].x += .5
    expect(visibleContours(view, map)).not.toBe(replacement)
    view.buildings = []
    expect(visibleContours(view, map)).toHaveLength(2)
  })
  it('never reuses a prior observer, match, operation or side cache', () => {
    const { view, map } = fixture()
    let previous = visibleContours(view, map)
    view.participants.find(p => p.id === view.you)!.seat++
    const newSeat = visibleContours(view, map); expect(newSeat).not.toBe(previous); previous = newSeat
    for (const patch of [{ you: 'another-viewer' }, { matchId: 'another-match' }, { operation: 2 }, { yourTeam: 'B' as const }]) {
      Object.assign(view, patch)
      const next = visibleContours(view, map); expect(next).not.toBe(previous); previous = next
    }
    view.teams.B.side = 'L'
    expect(visibleContours(view, map)).not.toBe(previous)
  })
  it('bounds remembered shapes instead of retaining every moving snapshot', () => {
    const { view, map } = fixture(), initial = visibleContours(view, map)
    for (let n = 1; n <= 5; n++) { view.units[0].x = 30 + n; visibleContours(view, map) }
    view.units[0].x = 30
    const next = visibleContours(view, map)
    expect(next).not.toBe(initial); expect(next).toEqual(initial)
  })
})
