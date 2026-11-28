import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { applyAction, createWorld, deserializeWorld, neutralInput, serializeWorld, setRewindEstimate, stepWorld, viewForPlayer } from '../src/core/index'
import { fighter, lineBlockers, nextId } from '../src/core/state'
import { opaqueId, sha256 } from '../src/core/ids'
import { unloadTransports } from '../src/core/operations'
import { isPointVisible, spatialEvent, withVisibilitySnapshot } from '../src/core/visibility'
import type { World } from '../src/core/types'

function fixture(): World {
  const w = createWorld({ matchId: 'privacy-fixture', mapId: 'FP01', firstSide: 'L', teamSize: 1, seed: 16, participants: [{ id: 'A1', name: 'A', team: 'A', controller: 'human' }, { id: 'B1', name: 'B', team: 'B', controller: 'human' }] })
  w.tick = 1000; w.phase = 'battle'; w.phaseStartTick = 1000; w.teams.A.nextTransportTick = 100000; w.teams.B.nextTransportTick = 100000
  const a = fighter(w, 'A1')!, b = fighter(w, 'B1')!; a.x = 12; a.z = 20; a.freshSpawn = false; b.x = 16; b.z = 21; b.freshSpawn = false
  w.history = [{ tick: 997, units: [{ id: a.id, team: 'A', generation: 1, x: 12, z: 20, radius: a.radius }, { id: b.id, team: 'B', generation: 1, x: 16, z: 20, radius: b.radius }], visible: { A: [b.id], B: [a.id] }, blockers: lineBlockers(w) }]
  return w
}
describe('rewind and safe event serialization', () => {
  it('uses zero/current, bounded 150 ms rewind, and clamps an excessive RTT estimate', () => {
    const current = fixture(); setRewindEstimate(current, 'A1', 0); stepWorld(current, { A1: { ...neutralInput(), firePressSeq: 1 } }); expect(fighter(current, 'B1')!.hp).toBe(100)
    for (const rtt of [300, 2000]) {
      const w = fixture(); setRewindEstimate(w, 'A1', rtt); expect(w.rewindTicks.A1).toBe(4)
      stepWorld(w, { A1: { ...neutralInput(), firePressSeq: 1 } }); expect(fighter(w, 'B1')!.hp).toBe(90)
    }
  })
  it('requires historical and current visibility and matching life generation', () => {
    for (const missing of ['past', 'present', 'generation'] as const) {
      const w = fixture(); setRewindEstimate(w, 'A1', 300)
      if (missing === 'past') w.history[0].visible.A = []
      if (missing === 'present') w.smokes.push({ id: 'hidden', team: 'B', ownerId: 'B1', x: 16, z: 21, radius: 3.5, expiresTick: 2000 })
      if (missing === 'generation') fighter(w, 'B1')!.generation = 2
      stepWorld(w, { A1: { ...neutralInput(), firePressSeq: 1 } }); expect(fighter(w, 'B1')!.hp).toBe(100)
    }
  })
  it('applies a shot once if both historical and current intersections are legal', () => {
    const w = fixture(); fighter(w, 'B1')!.z = 20; setRewindEstimate(w, 'A1', 300)
    stepWorld(w, { A1: { ...neutralInput(), firePressSeq: 1, fireHeld: true } }); expect(fighter(w, 'B1')!.hp).toBe(90); expect(fighter(w, 'A1')!.magazine).toBe(23)
  })
  it('has observer-local contiguous event sequences and no hidden hit endpoints', () => {
    const w = fixture(), b = fighter(w, 'B1')!; b.x = 20; b.z = 20
    w.smokes.push({ id: 'hidden', team: 'B', ownerId: 'B1', x: 16, z: 20, radius: 3.5, expiresTick: 2000 })
    stepWorld(w, { A1: { ...neutralInput(), firePressSeq: 1 } })
    const aView = viewForPlayer(w, 'A1'), bView = viewForPlayer(w, 'B1')
    expect(aView.events.filter(e => e.targetId === b.id)).toHaveLength(0)
    expect(bView.events.some(e => e.type === 'hurt' && e.targetId === b.id)).toBe(true)
    const ids = aView.events.map(e => e.seq); expect(ids.every((v, i) => i === 0 || v === ids[i - 1] + 1)).toBe(true)
    expect(aView.events.some(e => e.type === 'shot' && e.end?.x === 20 && e.end.z === 20)).toBe(false)
    expect(aView.smokes.some(s => s.id === 'hidden')).toBe(true)
    expect(aView.smokes.find(s => s.id === 'hidden')?.ownerId).toBeUndefined()
    expect(aView.smokes.find(s => s.id === 'hidden')?.expiresTick).toBeUndefined()
  })
  it('rejects hostile number values, prototype names and malformed commands without mutation', () => {
    const w = fixture(), credits = w.participants[0].credits
    expect(applyAction(w, 'A1', { type: 'build', kind: 'constructor', padId: 'L-01' }).ok).toBe(false)
    expect(applyAction(w, 'A1', { type: 'loadout', weapon: 'constructor' }).ok).toBe(false)
    expect(applyAction(w, 'A1', { type: 'order', unitIds: ['fighter:A1'], order: { type: 'move', point: { x: NaN, z: 2 } } }).ok).toBe(false)
    expect(w.participants[0].credits).toBe(credits); expect(w.buildOrders).toHaveLength(0)
  })
  it('serializes enemy radar transports through an explicit public whitelist, without escort or unloading telemetry', () => {
    const w = fixture()
    w.transports.push({ id: 'transport-B', team: 'B', side: 'R', route: 'N', x: 44, z: 8, angle: Math.PI, hp: 650, maxHp: 650, distance: 21, length: 46, speed: 1.5, escorted: true, unloadTicks: 60, lastDamageTick: 999 })
    const radar = viewForPlayer(w, 'A1').transports[0]
    expect(Object.keys(radar).sort()).toEqual(['angle', 'distance', 'hp', 'id', 'length', 'maxHp', 'route', 'side', 'team', 'x', 'z'].sort())
    expect(radar).toMatchObject({ id: 'transport-B', hp: 650, distance: 21, length: 46 })
    w.transports[0].speed = 0.7; w.transports[0].escorted = false; w.transports[0].unloadTicks = 0; w.transports[0].lastDamageTick = -10000
    expect(viewForPlayer(w, 'A1').transports[0]).toEqual(radar)
    expect(viewForPlayer(w, 'B1').transports[0]).toMatchObject({ speed: 0.7, escorted: false, unloadTicks: 0 })
    expect(viewForPlayer(w, 'B1').transports[0]).not.toHaveProperty('lastDamageTick')
  })
  it('shows observable protection and weapon without exposing enemy input, life count, orders or exact protection deadline', () => {
    const w = fixture(), b = fighter(w, 'B1')!
    b.generation = 9; b.protectedUntil = 1027; b.order = { type: 'attack', targetId: 'secret-own-fighter', lastPoint: { x: 8, z: 11 } }
    const enemy = viewForPlayer(w, 'A1').units.find(u => u.id === b.id)!
    expect(enemy).toMatchObject({ generation: 0, protected: true, weapon: 'carbine' })
    for (const key of ['protectedUntil', 'order', 'magazine', 'reloadUntil', 'targetId', 'lastDamageTick']) expect(enemy).not.toHaveProperty(key)
    expect(viewForPlayer(w, 'B1').units.find(u => u.id === b.id)).toMatchObject({ generation: 9, protectedUntil: 1027 })
    const enemyRoster = viewForPlayer(w, 'A1').participants.find(p => p.id === 'B1')!
    for (const key of ['statistics', 'refunds', 'credits', 'toolReadyTick', 'respawnAt', 'weapon', 'mode']) expect(enemyRoster).not.toHaveProperty(key)
  })
  it('whitelists nested event points even when the source is a full authoritative unit', () => {
    const w = fixture(), b = fighter(w, 'B1')!
    spatialEvent(w, b, 'observed-unit-effect', b.id)
    expect(w.events.A1.at(-1)?.point).toEqual({ x: b.x, z: b.z })
    w.events.A1.push({ seq: 100, tick: w.tick, type: 'legacy-event', point: b })
    for (const event of viewForPlayer(w, 'A1').events) if (event.point) expect(Object.keys(event.point).sort()).toEqual(['x', 'z'])
  })
  it('does not reveal hidden unloading participants through public start/interruption effects', () => {
    const w = fixture(), b = fighter(w, 'B1')!; b.x = 32; b.z = 20
    w.smokes.push({ id: 'unload-smoke', ownerId: 'B1', team: 'B', x: 32, z: 20, radius: 3.5, expiresTick: 2000 })
    w.transports.push({ id: 'transport-B', team: 'B', side: 'R', route: 'N', x: 32, z: 20, angle: Math.PI / 2, hp: 650, maxHp: 650, distance: 46, length: 46, speed: 0, escorted: true, unloadTicks: 0, lastDamageTick: -10000 })
    unloadTransports(w); expect(w.events.B1.some(e => e.type === 'unload-start')).toBe(true)
    b.z = 25; unloadTransports(w); expect(w.events.B1.some(e => e.type === 'unload-interrupted')).toBe(true)
    expect(w.events.A1.some(e => e.type.startsWith('unload'))).toBe(false)
    expect(viewForPlayer(w, 'A1').units.some(u => u.id === b.id)).toBe(false)
  })
  it('does not confirm a blind kill through a hidden unit-death sound', () => {
    const w = fixture(), b = fighter(w, 'B1')!; b.x = 20; b.z = 20; b.hp = 1; b.lastDamageTick = w.tick
    w.smokes.push({ id: 'blind-cloud', team: 'B', ownerId: 'B1', x: 16, z: 20, radius: 3.5, expiresTick: 2000 })
    stepWorld(w, { A1: { ...neutralInput(), firePressSeq: 1 } })
    expect(fighter(w, 'B1')).toBeUndefined()
    expect(w.events.A1.some(e => e.type.includes('destroyed') || e.type === 'hit' || e.targetId === b.id)).toBe(false)
    expect(w.events.B1.some(e => e.type === 'unit-lost' && e.targetId === b.id)).toBe(true)
  })
  it('damages a hidden barrier without emitting a target-specific hit marker', () => {
    const w = fixture(); fighter(w, 'B1')!.x = 40
    w.barriers.push({ id: 'secret-barrier', ownerId: 'B1', team: 'B', a: { x: 18, z: 18 }, b: { x: 18, z: 22 }, hp: 180, expiresTick: 2000 })
    w.smokes.push({ id: 'blind-cloud', team: 'B', ownerId: 'B1', x: 16, z: 20, radius: 3.5, expiresTick: 2000 })
    stepWorld(w, { A1: { ...neutralInput(), firePressSeq: 1 } })
    expect(w.barriers[0].hp).toBe(170)
    expect(w.events.A1.some(e => e.targetId === 'secret-barrier')).toBe(false)
  })
  it('keeps scoped visibility caching equivalent to direct geometry queries and discards it after movement', () => {
    const w = fixture(), points = Array.from({ length: 100 }, (_, i) => ({ x: 4 + i % 20 * 2.7, z: 3 + Math.floor(i / 20) * 7 }))
    w.smokes.push({ id: 'sample-cloud', team: 'B', ownerId: 'B1', x: 16, z: 20, radius: 3.5, expiresTick: 2000 })
    const direct = points.map(p => isPointVisible(w, 'A', p))
    expect(withVisibilitySnapshot(w, () => points.map(p => isPointVisible(w, 'A', p)))).toEqual(direct)
    w.smokes = []; const b = fighter(w, 'B1')!; b.x = 50
    expect(withVisibilitySnapshot(w, () => isPointVisible(w, 'A', b, b.id))).toBe(false)
    b.x = 15
    expect(withVisibilitySnapshot(w, () => isPointVisible(w, 'A', b, b.id))).toBe(true)
  })
  it('uses deterministic opaque IDs with a private persisted salt and matches the platform SHA-256 implementation', () => {
    for (const text of ['', 'abc', 'Форпост', 'a'.repeat(200)]) expect(sha256(text)).toBe(createHash('sha256').update(text).digest('hex'))
    const w = fixture(); w.idSalt = 'private-random-runtime-salt'
    const first = nextId(w, 'order'), restored = deserializeWorld(serializeWorld(w))
    expect(first).toMatch(/^order-[0-9a-f]{32}$/)
    expect(nextId(restored, 'order')).toBe(nextId(w, 'order'))
    expect(opaqueId('another-salt', 'order', 1)).not.toBe(first)
    const raw = JSON.stringify(viewForPlayer(w, 'A1'))
    expect(raw).not.toContain(w.idSalt); expect(raw).not.toContain('nextId')
  })
})
