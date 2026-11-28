import { describe, expect, it } from 'vitest'
import { applyAction, advanceWorld, buildEligibility, BUILDINGS, createWorld, deserializeWorld, getMap, MAPS, neutralInput, recomputePower, serializeWorld, setController, stepWorld, transportProgress, validateMap, viewForPlayer, WEAPONS } from '../src/core/index'
import { resolveDamage, removeBuilding } from '../src/core/economy'
import { chooseTarget } from '../src/core/combat'
import { planBots } from '../src/core/bots'
import { evaluateOperation, concludeOperation, unloadTransports } from '../src/core/operations'
import { createUnit, fighter } from '../src/core/state'
import { entityVisible, updateMemories } from '../src/core/visibility'
import { pointOnRoute } from '../src/core/geometry'
import { buildWorkPoint, orderPoint } from '../src/core/navigation'
import type { Building, BuildingKind, MapId, Team, World } from '../src/core/types'

function world(mapId: MapId = 'FP01', size: 1 | 2 | 3 = 1): World {
  return createWorld({ matchId: 'test', mapId, teamSize: size, seed: 8, firstSide: 'L', participants: (['A', 'B'] as Team[]).flatMap(team => Array.from({ length: size }, (_, i) => ({ id: `${team}${i + 1}`, name: `${team}${i + 1}`, team, controller: 'human' as const }))) })
}
function battle(w = world()): World { w.phase = 'battle'; w.tick = 1000; w.phaseStartTick = 1000; w.teams.A.nextTransportTick = 100000; w.teams.B.nextTransportTick = 100000; return w }
function building(w: World, ownerId: string, kind: BuildingKind, padId: string): Building {
  const pad = getMap(w.mapId).pads.find(p => p.id === padId)!, def = BUILDINGS[kind], p = w.participants.find(p => p.id === ownerId)!
  const b: Building = { id: `fixture-${padId}`, ownerId, team: p.team, kind, padId, x: pad.x, z: pad.z, hp: def.hp, maxHp: def.hp, createdTick: 1, completedTick: 1, workTicks: def.workTicks, powered: true, connected: true, disabledReason: null, sellUntil: null, lastDamageTick: -10000, lastAttackerId: null, angle: 0, nextShotExact: 0, targetId: null, targetSinceTick: 0, droneQueue: [], manualAim: null, suppressed: false }
  w.buildings.push(b); return b
}
function transport(w: World, team: Team, route: 'N' | 'S', fraction = 1) {
  const map = getMap(w.mapId), length = map.routeLengths[route], side = w.teams[team].side, p = pointOnRoute(map.routes[side][route], length * fraction)
  const t = { id: `fixture-transport-${team}`, team, route, side, hp: 650, maxHp: 650, distance: length * fraction, length, x: p.x, z: p.z, angle: p.angle, speed: 0, escorted: false, unloadTicks: 0, lastDamageTick: -10000 }
  w.transports.push(t); return t
}

describe('Forpost authoritative geometry and versioned state', () => {
  it('expands all three exact maps and validates fully occupied paths (F07)', () => {
    expect(MAPS.FP01.routeLengths).toEqual({ N: 46, S: 46 }); expect(MAPS.FP02.routeLengths).toEqual({ N: 53, S: 53 }); expect(MAPS.FP03.routeLengths).toEqual({ N: 61, S: 53 })
    for (const map of Object.values(MAPS)) expect(validateMap(map).errors).toEqual([])
  }, 30000)
  it('rejects corrupted map geometry rather than shipping a blocked route', () => {
    const map = structuredClone(MAPS.FP01); map.walls.push({ id: 'bad', x1: 11, z1: 18, x2: 15, z2: 22, destructible: false })
    expect(validateMap(map).errors.some(e => e.startsWith('route-reserve:'))).toBe(true)
  }, 30000)
  it('rejects unequal teams, bot-only rooms and unknown save versions (F02/F20)', () => {
    const w = world('FP01', 3)
    expect(w.participants).toHaveLength(6)
    const options = { matchId: 'bad', mapId: 'FP01' as const, teamSize: 1 as const, seed: 1, participants: [{ id: 'a', name: 'a', team: 'A' as const, controller: 'bot' as const }, { id: 'b', name: 'b', team: 'B' as const, controller: 'bot' as const }] }
    expect(() => createWorld(options)).toThrow('invalid-roster')
    expect(() => deserializeWorld(serializeWorld(w).replace('forpost-0.1', 'forpost-9.0'))).toThrow('unsupported-save')
  })
  it('replays exactly across serialization without a new seed or result (F10)', () => {
    const w = battle(); applyAction(w, 'A1', { type: 'build', padId: 'L-01', kind: 'relay', actionId: 'build-one' })
    advanceWorld(w, 90); const restored = deserializeWorld(serializeWorld(w))
    advanceWorld(w, 150); advanceWorld(restored, 150)
    expect(serializeWorld(restored)).toBe(serializeWorld(w))
  })
  it('normalizes diagonal movement, clamps collision and expires stale held input (F13/F17)', () => {
    const w = battle(), u = fighter(w, 'A1')!; u.x = 12; u.z = 18
    const start = { x: u.x, z: u.z }; stepWorld(w, { A1: { ...neutralInput(), moveX: 1, moveZ: 1, inputSeq: 1 } })
    expect(Math.hypot(u.x - start.x, u.z - start.z)).toBeLessThanOrEqual(0.151)
    advanceWorld(w, 7); const stopped = { x: u.x, z: u.z }; advanceWorld(w, 30)
    expect({ x: u.x, z: u.z }).toEqual(stopped)
    u.x = 18.6; u.z = 23; advanceWorld(w, 30, () => ({ A1: { ...neutralInput(), moveX: 1 } }))
    expect(u.x).toBeLessThan(19 - u.radius)
  })
  it('changes temporary controller without replacing the human owner (F13)', () => {
    const w = world(); setController(w, 'A1', 'bot'); expect(w.participants[0].controller).toBe('human'); expect(w.participants[0].temporaryBot).toBe(true)
    setController(w, 'A1', 'human'); expect(w.participants[0].temporaryBot).toBe(false); expect(w.participants[0].input.fireHeld).toBe(false)
  })
  it('uses the normal takeover policy for battery purchases without changing a permanent strong bot', () => {
    for (const temporary of [false, true]) {
      const w = battle(), p = w.participants[0]; w.phase = 'overtime'; p.botLevel = 'strong'; p.credits = 240
      if (temporary) setController(w, p.id, 'bot'); else p.controller = 'bot'
      building(w, p.id, 'relay', 'L-01'); building(w, p.id, 'turret', 'L-03'); building(w, p.id, 'post', 'L-02')
      const dock = building(w, p.id, 'dock', 'L-15'); for (const station of w.stations) station.owner = p.team
      recomputePower(w)
      // A legitimately disconnected dock and controlled stations leave room and power for a battery.
      expect(dock.powered).toBe(false); expect(p.powerUsed).toBeLessThan(p.power - 1)
      expect(Object.values(viewForPlayer(w, p.id).buildOptions).some(options => options.some(o => o.kind === 'battery' && o.ok))).toBe(true)
      planBots(w)
      expect(w.buildOrders.filter(o => o.ownerId === p.id && o.kind === 'battery')).toHaveLength(temporary ? 0 : 1)
      expect(p.credits).toBe(temporary ? 240 : 60); expect(p.botLevel).toBe('strong')
      expect(p.controller).toBe(temporary ? 'human' : 'bot')
    }
  })
  it('uses the normal takeover policy for a visible route threat without changing a permanent novice bot', () => {
    for (const temporary of [false, true]) {
      const w = battle(), p = w.participants[0], own = fighter(w, p.id)!, enemy = fighter(w, 'B1')!
      p.botLevel = 'novice'; p.credits = 0; own.x = 12; own.z = 18; enemy.x = 16; enemy.z = 18
      if (temporary) setController(w, p.id, 'bot'); else p.controller = 'bot'
      w.teams.A.manualRoute = 'N'; w.teams.A.routeChangedTick = 0; w.teams.A.humanRouteTick = 0
      expect(viewForPlayer(w, p.id).units.some(u => u.id === enemy.id)).toBe(true)
      planBots(w)
      expect(w.teams.A.manualRoute).toBe(temporary ? 'S' : 'N')
      expect(w.teams.A.routeAuthorId).toBe(temporary ? p.id : null); expect(p.botLevel).toBe('novice')
      expect(p.controller).toBe(temporary ? 'human' : 'bot')
    }
  })
})

describe('weapons, protection, private projections and real damage', () => {
  it('keeps the exact 8 Hz carbine cadence at 30 Hz and handles a short press once', () => {
    const w = battle(), u = fighter(w, 'A1')!; u.x = 12; u.z = 20
    advanceWorld(w, 30, () => ({ A1: { ...neutralInput(), fireHeld: true, aimX: 0, aimZ: -1 } }))
    expect(u.magazine).toBe(16)
    advanceWorld(w, 8); const before = u.magazine
    stepWorld(w, { A1: { ...neutralInput(), fireHeld: false, firePressSeq: 7, aimX: 0, aimZ: -1 } }); advanceWorld(w, 8)
    expect(u.magazine).toBe(before - 1)
  })
  it('spends one shell for all six shotgun rays and repeated reload never accelerates it', () => {
    const w = battle(), p = w.participants[0], u = fighter(w, 'A1')!; p.weapon = 'shotgun'; u.magazine = 5; u.x = 12; u.z = 20
    stepWorld(w, { A1: { ...neutralInput(), fireHeld: true, aimX: 0, aimZ: -1 } }); expect(u.magazine).toBe(4)
    expect(applyAction(w, p.id, { type: 'reload' }).ok).toBe(true); const until = u.reloadUntil
    expect(applyAction(w, p.id, { type: 'reload' }).code).toBe('reloading'); expect(u.reloadUntil).toBe(until)
    advanceWorld(w, WEAPONS.shotgun.reloadTicks); expect(u.magazine).toBe(5)
  })
  it('cannot shoot out of the protected base or refresh tool cooldown on death', () => {
    const w = battle(), u = fighter(w, 'A1')!, p = w.participants[0]
    stepWorld(w, { A1: { ...neutralInput(), fireHeld: true } }); expect(u.magazine).toBe(24)
    p.toolReadyTick = w.tick + 450; const cooldown = p.toolReadyTick
    resolveDamage(w, [{ targetId: u.id, sourceId: 'fixture', sourceOwnerId: 'B1', sourceTeam: 'B', amount: 200, generation: u.generation }]); advanceWorld(w, 150)
    expect(fighter(w, 'A1')).toBeDefined(); expect(p.toolReadyTick).toBe(cooldown)
  })
  it('deals blind damage through smoke without hitmarker, target ID, stats, enemy economy or orders (F11)', () => {
    const w = battle(), a = fighter(w, 'A1')!, b = fighter(w, 'B1')!; a.x = 12; a.z = 20; b.x = 20; b.z = 20; b.freshSpawn = false
    w.smokes.push({ id: 'fixture-smoke', ownerId: 'A1', team: 'A', x: 16, z: 20, radius: 3.5, expiresTick: w.tick + 180 })
    expect(entityVisible(w, 'A', b)).toBe(false)
    stepWorld(w, { A1: { ...neutralInput(), fireHeld: true } })
    expect(b.hp).toBe(90)
    const view = viewForPlayer(w, 'A1'); expect(view.units.some(u => u.id === b.id)).toBe(false); expect(view.events.some(e => e.type === 'hit' && e.targetId === b.id)).toBe(false)
    expect(view.teams.B.charge).toBeUndefined(); expect(view.participants.find(p => p.id === 'B1')?.credits).toBeUndefined(); expect(view.participants[0].statistics).toBeUndefined()
    expect(JSON.stringify(view)).not.toContain('botRandom'); expect(JSON.stringify(view)).not.toContain('rewindTicks')
  })
  it('ignores damage addressed to the previous life (F12)', () => {
    const w = battle(), u = fighter(w, 'A1')!; u.generation = 2
    resolveDamage(w, [{ targetId: u.id, generation: 1, sourceId: 'old-shot', sourceOwnerId: 'B1', sourceTeam: 'B', amount: 100 }]); expect(u.hp).toBe(100)
  })
  it('preserves stale building intelligence until a new actual observation', () => {
    const w = battle(), b = building(w, 'B1', 'turret', 'R-01'), observer = fighter(w, 'A1')!
    observer.x = b.x - 4; observer.z = b.z; updateMemories(w); expect(w.memories.A[b.id]).toBeDefined()
    observer.x = 5; observer.z = 20; const oldHp = w.memories.A[b.id].hp; b.hp = 15; updateMemories(w)
    expect(viewForPlayer(w, 'A1').memories.find(m => m.id === b.id)?.hp).toBe(oldHp)
  })
})

describe('construction, income, power and atomic sales', () => {
  it('reserves a pad once across owners and replays the same command after restart (F09/F10)', () => {
    const w = world('FP01', 2), action = { type: 'build' as const, padId: 'L-01', kind: 'relay' as const, actionId: 'once' }
    const first = applyAction(w, 'A1', action); expect(first.ok).toBe(true)
    expect(applyAction(w, 'A2', { ...action, actionId: 'other' }).code).toBe('pad-occupied')
    const restored = deserializeWorld(serializeWorld(w)); expect(applyAction(restored, 'A1', action)).toEqual(first)
    expect(restored.participants.find(p => p.id === 'A1')!.credits).toBe(160); expect(restored.buildOrders).toHaveLength(1)
    expect(applyAction(restored, 'A1', { ...action, padId: 'L-02' }).code).toBe('action-id-conflict')
  })
  it('gives capped refunds with visible credited/lost amounts, never double refunds (F09)', () => {
    const w = world(), result = applyAction(w, 'A1', { type: 'build', padId: 'L-01', kind: 'relay' }); w.participants[0].credits = 590
    const action = { type: 'cancelBuild' as const, orderId: result.entityId!, actionId: 'cancel-once' }
    const refund = applyAction(w, 'A1', action); expect(refund.refund).toEqual({ calculated: 60, credited: 10, lost: 50 }); expect(w.participants[0].credits).toBe(600)
    expect(applyAction(w, 'A1', action)).toEqual(refund); expect(w.participants[0].credits).toBe(600)
  })
  it('requires physical builder travel then full work time and does not heal the foundation', () => {
    const w = battle(), result = applyAction(w, 'A1', { type: 'build', padId: 'L-01', kind: 'relay' }); expect(result.ok).toBe(true)
    advanceWorld(w, 15); expect(w.buildings).toHaveLength(0)
    for (let i = 0; i < 300 && !w.buildings.length; i++) stepWorld(w)
    const b = w.buildings[0]; expect(b).toBeDefined(); b.hp = 60
    advanceWorld(w, BUILDINGS.relay.workTicks - 1); expect(b.completedTick).toBeNull()
    stepWorld(w); expect(b.completedTick).not.toBeNull(); expect(b.hp).toBe(60)
  })
  it('does not energize an unreachable relay cycle with its own generator (F08)', () => {
    const w = battle(); const a = building(w, 'A1', 'relay', 'L-13'), b = building(w, 'A1', 'relay', 'L-14'), gen = building(w, 'A1', 'generator', 'L-15')
    recomputePower(w); expect(a.powered).toBe(false); expect(b.powered).toBe(false); expect(gen.powered).toBe(false); expect(w.participants[0].power).toBe(6)
  })
  it('powers relay first then respects the owner consumer priority, skipping one that does not fit', () => {
    const w = battle(); building(w, 'A1', 'relay', 'L-01'); const battery = building(w, 'A1', 'battery', 'L-03'), dock = building(w, 'A1', 'dock', 'L-04'), extractor = building(w, 'A1', 'extractor', 'L-02')
    w.participants[0].priority = [battery.id, dock.id, extractor.id]; recomputePower(w)
    expect(battery.powered).toBe(true); expect(dock.powered).toBe(true); expect(extractor.powered).toBe(false)
    w.participants[0].priority = [extractor.id, battery.id, dock.id]; recomputePower(w); expect(extractor.powered).toBe(true); expect(dock.powered).toBe(false)
  })
  it('forecasts a new higher-priority consumer using the same allocation order as the core', () => {
    const w = battle(); building(w, 'A1', 'relay', 'L-01'); building(w, 'A1', 'battery', 'L-03'); building(w, 'A1', 'dock', 'L-04'); building(w, 'A1', 'extractor', 'L-02'); recomputePower(w)
    expect(w.participants[0].power - w.participants[0].powerUsed).toBe(0)
    expect(buildEligibility(w, 'A1', 'L-07', 'post')).toMatchObject({ ok: true, willBePowered: true })
  })
  it('activates a completed turret on exactly the following tick before target acquisition', () => {
    const w = battle(), turret = building(w, 'A1', 'turret', 'L-03'), enemy = fighter(w, 'B1')!
    turret.completedTick = w.tick; turret.powered = false; enemy.x = 14; enemy.z = 14; enemy.freshSpawn = false
    stepWorld(w); expect(turret.targetId).toBe(enemy.id); expect(turret.targetSinceTick).toBe(1001)
    advanceWorld(w, 7); expect(enemy.hp).toBe(100)
    stepWorld(w); expect(enemy.hp).toBe(92)
  })
  it('continues foundation work during its two-second sale window', () => {
    const w = battle(), b = building(w, 'A1', 'relay', 'L-01'), unit = w.units.find(u => u.ownerId === 'A1' && u.kind === 'builder')!
    b.completedTick = null; b.workTicks = BUILDINGS.relay.workTicks - 1; b.sellUntil = w.tick + 60
    w.buildOrders.push({ id: 'work-during-sale', ownerId: 'A1', kind: 'relay', padId: b.padId, createdTick: 1, buildingId: b.id })
    const at = buildWorkPoint(w, unit, b.padId)!; unit.x = at.x; unit.z = at.z
    stepWorld(w); expect(b.completedTick).toBe(w.tick); expect(w.buildings).toContain(b)
  })
  it('does not restore fighter HP on a tick that receives damage', () => {
    const w = battle(), a = fighter(w, 'A1')!, b = fighter(w, 'B1')!; a.x = 12; a.z = 20; a.hp = 50; a.lastDamageTick = 0; a.freshSpawn = false; b.x = 16; b.z = 20; b.freshSpawn = false
    stepWorld(w, { B1: { ...neutralInput(), aimX: -1, firePressSeq: 1 } }); expect(a.hp).toBe(40)
  })
  it('can resume an explicitly paused builder queue and exposes that status only to its team', () => {
    const w = battle(), unit = w.units.find(u => u.ownerId === 'A1' && u.kind === 'builder')!
    applyAction(w, 'A1', { type: 'build', padId: 'L-01', kind: 'relay' }); applyAction(w, 'A1', { type: 'order', unitIds: [unit.id], order: { type: 'return' } })
    expect(viewForPlayer(w, 'A1').participants[0].builderPaused).toBe(true); expect(viewForPlayer(w, 'B1').participants[0].builderPaused).toBeUndefined()
    expect(applyAction(w, 'A1', { type: 'resumeBuild' }).ok).toBe(true); expect(w.participants[0].builderPaused).toBe(false)
  })
  it('removes a selling dock before the simultaneous drone completion and refunds 30+60 (F21)', () => {
    const w = battle(), b = building(w, 'A1', 'dock', 'L-01'); w.participants[0].credits = 500
    b.droneQueue = [{ id: 'one', ownerId: 'A1', started: true, workTicks: 239 }, { id: 'two', ownerId: 'A1', started: false, workTicks: 0 }]; b.sellUntil = w.tick + 1
    stepWorld(w); expect(w.buildings.some(v => v.id === b.id)).toBe(false); expect(w.units.filter(u => u.kind === 'drone')).toHaveLength(0)
    expect(w.participants[0].refunds.map(r => r.calculated)).toEqual([30, 60, 60]); expect(w.participants[0].credits).toBe(600)
  })
  it('new damage cancels an ongoing sale without deleting production', () => {
    const w = battle(), b = building(w, 'A1', 'dock', 'L-01'); b.sellUntil = w.tick + 30
    b.droneQueue = [{ id: 'one', ownerId: 'A1', started: true, workTicks: 10 }]
    resolveDamage(w, [{ targetId: b.id, amount: 8, sourceId: 'enemy', sourceOwnerId: 'B1', sourceTeam: 'B' }]); expect(b.sellUntil).toBeNull(); expect(b.droneQueue[0].workTicks).toBe(10)
    expect(applyAction(w, 'A1', { type: 'sell', buildingId: b.id }).code).toBe('recent-damage')
  })
  it('evacuates both teams from a sold/destroyed bridge with the specified 0/25 damage (F22)', () => {
    for (const sold of [true, false]) {
      const w = battle()
      // Fixture uses the defined FP01 bridge; only the state is arranged, not ordinary play.
      const b = building(w, 'A1', 'bridge', 'L-bridge'), a = fighter(w, 'A1')!, enemy = fighter(w, 'B1')!; a.x = 21; a.z = 14.5; enemy.x = 23; enemy.z = 14.5
      removeBuilding(w, b, sold)
      expect(a.x < 20 || a.x > 24).toBe(true); expect(enemy.x < 20 || enemy.x > 24).toBe(true); expect(a.hp).toBe(sold ? 100 : 75); expect(enemy.hp).toBe(sold ? 100 : 75)
    }
  })
})

describe('transport and complete bounded match outcomes', () => {
  it('releases the first transport after exactly five battle seconds and freezes its route', () => {
    const w = world(); advanceWorld(w, 749); expect(w.transports).toHaveLength(0); stepWorld(w); expect(w.transports).toHaveLength(2)
    const t = w.transports.find(t => t.team === 'A')!; expect(t.route).toBe('N'); applyAction(w, 'A1', { type: 'route', route: 'S' }); expect(t.route).toBe('N')
  })
  it('compares current normalized 61/53 route progress, not distance or previous maximum (F04)', () => {
    const w = battle(world('FP03')); const a = transport(w, 'A', 'N', 0.5), b = transport(w, 'B', 'S', 0.5)
    expect(a.distance).toBe(30.5); expect(b.distance).toBe(26.5); expect(transportProgress(w, 'A')).toBe(5000); expect(transportProgress(w, 'B')).toBe(5000)
    w.transports = w.transports.filter(t => t.id !== a.id); expect(transportProgress(w, 'A')).toBe(0)
  })
  it('contesting resets unload; destroying at the last tick prevents delivery (F06)', () => {
    const w = battle(), t = transport(w, 'A', 'N'), a = fighter(w, 'A1')!, b = fighter(w, 'B1')!; a.x = 32; a.z = 20; b.x = 32; b.z = 21; t.unloadTicks = 80
    unloadTransports(w); expect(t.unloadTicks).toBe(0); b.x = 50; t.unloadTicks = 89
    resolveDamage(w, [{ targetId: t.id, amount: 650, sourceId: 'enemy', sourceOwnerId: 'B1', sourceTeam: 'B' }]); unloadTransports(w); expect(w.teams.A.deliveries).toBe(0)
  })
  it('simultaneous third delivery enters overtime independent of team traversal (F05)', () => {
    const w = battle(); w.teams.A.deliveries = 3; w.teams.B.deliveries = 3; evaluateOperation(w); expect(w.phase).toBe('overtime'); expect(w.operations).toHaveLength(0)
  })
  it('ends at two wins without creating operation three (F01)', () => {
    const w = battle(); concludeOperation(w, 'A', 'deliveries'); advanceWorld(w, 450); expect(w.operation).toBe(2)
    w.phase = 'battle'; concludeOperation(w, 'A', 'deliveries'); expect(w.phase).toBe('finished'); expect(w.winner).toBe('A'); expect(w.operation).toBe(2)
  })
  it('one win and two drawn operations is a 1:0 match victory, while 1:1 is a draw (F03)', () => {
    for (const middle of [null, 'B'] as const) {
      const w = battle(); concludeOperation(w, 'A', 'deliveries'); advanceWorld(w, 450); w.phase = 'battle'; concludeOperation(w, middle, middle ? 'deliveries' : 'equal'); advanceWorld(w, 450); w.phase = 'battle'; concludeOperation(w, null, 'equal')
      expect(w.phase).toBe('finished'); expect(w.winner).toBe(middle ? null : 'A'); expect(w.operations).toHaveLength(3)
      const before = serializeWorld(w); stepWorld(w); expect(serializeWorld(w)).toBe(before)
    }
  })
  it('a suppressed post reveals the allowed area status, not the hidden suppressor (F16)', () => {
    const w = battle(), post = building(w, 'A1', 'post', 'L-01'), enemy = fighter(w, 'B1')!; enemy.x = post.x + 4; enemy.z = post.z
    w.smokes.push({ id: 's', ownerId: 'B1', team: 'B', x: enemy.x, z: enemy.z, radius: 3.5, expiresTick: w.tick + 180 }); recomputePower(w)
    expect(post.suppressed).toBe(true); expect(viewForPlayer(w, 'A1').units.some(u => u.id === enemy.id)).toBe(false)
  })
  it('tactical mode preserves drone orders while direct fighter control resumes', () => {
    const w = battle(), p = w.participants[0], d = createUnit(w, p, 'drone', { x: 12, z: 20 }); w.units.push(d)
    expect(applyAction(w, p.id, { type: 'order', unitIds: [d.id], order: { type: 'escort' } }).ok).toBe(true)
    applyAction(w, p.id, { type: 'mode', mode: 'tactics' }); applyAction(w, p.id, { type: 'mode', mode: 'fighter' }); expect(d.order.type).toBe('escort'); expect(p.mode).toBe('fighter')
  })
  it('guards the current fighter position on first tactics entry and preserves an explicit later order', () => {
    const w = battle(), u = fighter(w, 'A1')!; u.x = 12; u.z = 19
    applyAction(w, 'A1', { type: 'mode', mode: 'tactics' })
    expect(u.order).toEqual({ type: 'guard', point: { x: 12, z: 19 } })
    applyAction(w, 'A1', { type: 'order', unitIds: [u.id], order: { type: 'guard', point: { x: 14, z: 19 } } })
    applyAction(w, 'A1', { type: 'mode', mode: 'fighter' }); applyAction(w, 'A1', { type: 'mode', mode: 'tactics' })
    expect(u.order).toEqual({ type: 'guard', point: { x: 14, z: 19 } })
  })
  it('travels to the last observed attack point before starting the bounded three-second search', () => {
    const w = battle(), a = fighter(w, 'A1')!, b = fighter(w, 'B1')!; a.x = 12; a.z = 20; b.x = 18; b.z = 20
    expect(applyAction(w, 'A1', { type: 'order', unitIds: [a.id], order: { type: 'attack', targetId: b.id } }).ok).toBe(true)
    b.x = 50; w.tick += 600
    expect(orderPoint(w, a)).toEqual({ x: 18, z: 20 }); expect(a.order).toMatchObject({ lostAt: -1 })
    a.x = 18; orderPoint(w, a); expect(a.order).toMatchObject({ lostAt: w.tick })
    w.tick += 89; expect(orderPoint(w, a)).toEqual({ x: 18, z: 20 })
    w.tick++; expect(orderPoint(w, a)).toBeNull(); expect(a.order.type).toBe('guard')
  })
  it('emits one aggregated hit and hurt event for one shotgun trigger', () => {
    const w = battle(), a = fighter(w, 'A1')!, b = fighter(w, 'B1')!; a.x = 12; a.z = 20; b.x = 14; b.z = 20; a.freshSpawn = false; b.freshSpawn = false
    w.participants[0].weapon = 'shotgun'; a.magazine = 5
    stepWorld(w, { A1: { ...neutralInput(), firePressSeq: 1 } })
    expect(b.hp).toBe(52); expect(w.events.A1.filter(e => e.type === 'hit' && e.targetId === b.id)).toHaveLength(1)
    expect(w.events.A1.find(e => e.type === 'hit' && e.targetId === b.id)?.value).toBe(48)
    expect(w.events.B1.filter(e => e.type === 'hurt' && e.targetId === b.id)).toHaveLength(1)
  })
  it('honors an explicit visible attack target for fighter and drone fire before default target priorities', () => {
    const w = battle(), a = fighter(w, 'A1')!, enemyFighter = fighter(w, 'B1')!, enemyBuilder = w.units.find(u => u.ownerId === 'B1' && u.kind === 'builder')!
    a.x = 12; a.z = 20; a.freshSpawn = false; enemyFighter.x = 14; enemyFighter.z = 21; enemyFighter.freshSpawn = false
    enemyBuilder.x = 15; enemyBuilder.z = 20; enemyBuilder.order = { type: 'guard', point: { x: 15, z: 20 } }
    expect(chooseTarget(w, a, 26, 'fighter')?.id).toBe(enemyFighter.id)
    applyAction(w, 'A1', { type: 'mode', mode: 'tactics' }); applyAction(w, 'A1', { type: 'order', unitIds: [a.id], order: { type: 'attack', targetId: enemyBuilder.id } })
    w.participants[0].aimError = 0; w.participants[0].aimErrorUntil = w.tick + 100
    expect(chooseTarget(w, a, 26, 'fighter')?.id).toBe(enemyBuilder.id)
    advanceWorld(w, 9); expect(enemyBuilder.hp).toBe(70); expect(enemyFighter.hp).toBe(100)
    const drone = createUnit(w, w.participants[0], 'drone', { x: 12, z: 18 }); drone.order = { type: 'attack', targetId: enemyBuilder.id }
    expect(chooseTarget(w, drone, 14, 'drone')?.id).toBe(enemyBuilder.id)
    enemyBuilder.x = 50; expect(chooseTarget(w, drone, 14, 'drone')?.id).toBe(enemyFighter.id)
  })
})
