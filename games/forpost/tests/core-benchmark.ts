import { BUILDINGS, createWorld, getMap, neutralInput, recomputePower, serializeWorld, stepWorld, viewForPlayer } from '../src/core/index'
import { createUnit, movementObstacles } from '../src/core/state'
import { legalPoint, pointOnRoute } from '../src/core/geometry'
import { chooseTarget } from '../src/core/combat'
import { buildWorkPoint } from '../src/core/navigation'
import type { BuildingKind, Input, Team, World } from '../src/core/types'

export function maxSceneFixtures(): World[] {
    const roster = (['A', 'B'] as Team[]).flatMap(team => Array.from({ length: 3 }, (_, i) => ({ id: `${team}${i + 1}`, name: `${team}${i + 1}`, team, controller: 'human' as const })))
    const w = createWorld({ matchId: 'max-scene', mapId: 'FP01', teamSize: 3, seed: 47, firstSide: 'L', participants: roster })
    w.phase = 'battle'; w.tick = 1000; w.phaseStartTick = 1000
    const map = getMap(w.mapId), kinds: BuildingKind[] = ['relay', 'generator', 'turret', 'dock', 'extractor'], placement = [[3, 1, 13, 2, 5], [8, 4, 14, 6, 7], [10, 9, 15, 11, 12]]
    for (const p of w.participants) {
      const side = w.teams[p.team].side, pads = placement[p.seat - 1].map(index => map.pads.find(pad => pad.id === `${side}-${String(index).padStart(2, '0')}`)!)
      for (const [i, pad] of pads.entries()) { const kind = kinds[i], def = BUILDINGS[kind]; w.buildings.push({ id: `max-${pad.id}`, ownerId: p.id, team: p.team, kind, padId: pad.id, x: pad.x, z: pad.z, hp: def.hp, maxHp: def.hp, createdTick: 1, completedTick: 1, workTicks: def.workTicks, powered: true, connected: true, disabledReason: null, sellUntil: null, lastDamageTick: -10000, lastAttackerId: null, angle: p.team === 'A' ? 0 : Math.PI, nextShotExact: 0, targetId: null, targetSinceTick: 0, droneQueue: [], manualAim: null, suppressed: false }) }
      for (let i = 0; i < 2; i++) { const u = createUnit(w, p, 'drone', { x: p.team === 'A' ? 30 : 34, z: 12 + p.seat * 4 + i }); u.order = { type: 'escort' }; w.units.push(u) }
      const hero = w.units.find(u => u.ownerId === p.id && u.kind === 'fighter')!; hero.x = p.team === 'A' ? 30 : 34; hero.z = 13 + p.seat * 3; hero.freshSpawn = false
      w.smokes.push({ id: `max-smoke-${p.id}`, ownerId: p.id, team: p.team, x: p.team === 'A' ? 24 : 40, z: 10 + p.seat * 5, radius: 3.5, expiresTick: 1180 })
    }
    for (const team of ['A', 'B'] as Team[]) { const side = w.teams[team].side, position = pointOnRoute(map.routes[side].N, 34); w.transports.push({ id: `max-transport-${team}`, team, side, route: 'N', hp: 650, maxHp: 650, distance: 34, length: 46, x: position.x, z: position.z, angle: position.angle, speed: 1.5, escorted: true, unloadTicks: 0, lastDamageTick: -1000 }) }
    for (const p of w.participants) {
      const foundation = w.buildings.find(b => b.ownerId === p.id && b.kind === 'extractor')!, unit = w.units.find(u => u.ownerId === p.id && u.kind === 'builder')!
      foundation.completedTick = null; foundation.workTicks = 30
      w.buildOrders.push({ id: `max-order-${p.id}`, ownerId: p.id, padId: foundation.padId, kind: foundation.kind, createdTick: 1, buildingId: foundation.id })
      const at = buildWorkPoint(w, unit, foundation.padId)!
      unit.x = at.x; unit.z = at.z
    }
    recomputePower(w)
    const barrierScene = structuredClone(w); barrierScene.smokes = []; barrierScene.barriers = roster.map((p, i) => ({ id: `max-barrier-${i}`, ownerId: p.id, team: p.team, a: { x: 25 + i * 2, z: 16 }, b: { x: 25 + i * 2, z: 20 }, hp: 180, expiresTick: 1120 }))
    const mixedScene = structuredClone(w); mixedScene.smokes = mixedScene.smokes.slice(0, 3); mixedScene.barriers = structuredClone(barrierScene.barriers.slice(3))
    const fixtures = [w, barrierScene, mixedScene]
    for (const fixture of fixtures) {
      for (const source of [...fixture.units, ...fixture.buildings]) if (source.kind === 'drone' || source.kind === 'turret') {
        const target = chooseTarget(fixture, source, 14, source.kind)
        if (target) { source.targetId = target.id; source.targetSinceTick = 900; source.angle = Math.atan2(target.z - source.z, target.x - source.x) }
      }
    }
    return fixtures
}

export function benchmarkCore(sampleCount = 500, warmupCount = 30, traceSamples = false) {
    const reports = []
    for (const fixture of maxSceneFixtures()) {
      const map = getMap(fixture.mapId)
      const samples: number[] = [], cpuSamples: number[] = [], warming: number[] = [], snapshotBytes: number[] = [], shots: number[] = []
      // Every sample restores all entities and cooldowns; deaths never silently reduce the workload.
      // Warmup is reported separately, not discarded from the evidence.
      for (let i = -warmupCount; i < sampleCount; i++) {
        const copy = structuredClone(fixture), inputs: Record<string, Input> = {}
        for (const p of copy.participants) inputs[p.id] = { ...neutralInput(), fireHeld: true, aimX: p.team === 'A' ? 1 : -1 }
        const cpuStart = process.cpuUsage(), start = performance.now(); stepWorld(copy, inputs); const duration = performance.now() - start, cpu = process.cpuUsage(cpuStart)
        if (i < 0) warming.push(duration); else { samples.push(duration); cpuSamples.push((cpu.user + cpu.system) / 1000) }
        if (i >= 0 && i < 5) {
          snapshotBytes.push(JSON.stringify(viewForPlayer(copy, 'A1')).length)
          shots.push(new Set(Object.values(copy.events).flat().filter(e => e.type === 'muzzle').map(e => e.actorId)).size)
        }
      }
      const samplesInOrder = traceSamples ? [...samples] : undefined
      samples.sort((a, b) => a - b)
      cpuSamples.sort((a, b) => a - b)
      const percentile = (p: number) => samples[Math.ceil(samples.length * p) - 1]
      reports.push({ workload: `Forpost max scene, ${fixture.smokes.length} smokes + ${fixture.barriers.length} barriers, fresh explicit fixture per sample`, samples: samples.length, ...(samplesInOrder ? { samplesInOrder } : {}), coldStepMs: warming[0], warmupMaxMs: Math.max(...warming), p50ms: percentile(0.5), p95ms: percentile(0.95), p99ms: percentile(0.99), p99cpuMs: cpuSamples[Math.ceil(cpuSamples.length * 0.99) - 1], maxMs: samples[samples.length - 1], observedFiringSources: Math.max(...shots), maxViewBytes: Math.max(...snapshotBytes), fullWorldBytes: serializeWorld(fixture).length, fighters: fixture.units.filter(u => u.kind === 'fighter').length, builders: fixture.units.filter(u => u.kind === 'builder').length, drones: fixture.units.filter(u => u.kind === 'drone').length, buildings: fixture.buildings.length, transports: fixture.transports.length, activeConstruction: fixture.buildOrders.length, tools: fixture.smokes.length + fixture.barriers.length, illegalUnits: fixture.units.filter(u => !legalPoint(u, u.radius, map, movementObstacles(fixture, u.team))).map(u => u.id) })
    }
    return reports
}
