import { BUILDINGS, RULES, WEAPONS } from './constants'
import { creditRefund, sellRefund } from './actions'
import type { Damage } from './combat'
import { circleIntersectsRect, closestLegalPoint, distance, insideRect, legalPoint } from './geometry'
import { getMap } from './maps'
import { buildWorkPoint } from './navigation'
import { builder, createUnit, movementObstacles, nextId, participant } from './state'
import { sightClear, spatialEvent, teamEvent } from './visibility'
import type { Building, Participant, Point, Unit, World } from './types'

export function removeUnit(w: World, u: Unit): void {
  const p = participant(w, u.ownerId)!
  if (u.kind === 'fighter') { p.respawnAt = w.tick + (4 + w.teamSize) * 30; p.fighterGeneration++; p.repair = null; p.pendingLoadout = null }
  if (u.kind === 'builder') { p.builderRespawnAt = w.tick + RULES.builderRespawnTicks; p.builderGeneration++ }
  w.units = w.units.filter(v => v.id !== u.id)
  // A hidden death must not be confirmed by a special destruction sound.
  spatialEvent(w, u, 'unit-destroyed', u.id)
  teamEvent(w, u.team, { type: 'unit-lost', targetId: u.id })
}
export function removeBuilding(w: World, b: Building, sold: boolean): void {
  const map = getMap(w.mapId), p = participant(w, b.ownerId)!, pad = map.pads.find(p => p.id === b.padId)!
  w.buildings = w.buildings.filter(other => other.id !== b.id); w.buildOrders = w.buildOrders.filter(o => o.buildingId !== b.id)
  for (const order of b.droneQueue) creditRefund(w, p, order.started ? 30 : 60, sold ? 'dock-sold' : 'dock-destroyed')
  if (sold) creditRefund(w, p, sellRefund(b), 'building-sold')
  w.navigationVersion++
  if (b.kind === 'bridge' && b.completedTick !== null) {
    for (const u of [...w.units]) if (circleIntersectsRect(u, u.radius, pad.rect)) {
      const obstacles = movementObstacles(w, u.team)
      const bank = closestLegalPoint(u, u.radius, map, obstacles, 10, candidate => candidate.x + u.radius < pad.rect.x1 || candidate.x - u.radius > pad.rect.x2)
      const destination = bank ?? map.depots[w.teams[u.team].side]
      if (!bank) w.technicalErrors.push(`bridge-bank:${w.tick}:${b.padId}:${u.id}`)
      u.x = destination.x; u.z = destination.z; u.path = []; u.pathTarget = null; u.vx = 0; u.vz = 0
      if (!sold) { u.hp = Math.max(0, u.hp - 25); u.lastDamageTick = w.tick; if (!u.hp) removeUnit(w, u) }
      teamEvent(w, u.team, { type: sold ? 'bridge-evacuated' : 'bridge-collapse', targetId: u.id, point: destination, value: sold ? 0 : 25 })
    }
  }
  spatialEvent(w, b, sold ? 'building-sold' : 'building-destroyed', b.id, 14)
}
export function resolveDamage(w: World, damages: Damage[]): void {
  const grouped = new Map<string, Damage[]>()
  for (const d of damages) grouped.set(d.targetId, [...(grouped.get(d.targetId) ?? []), d])
  const deadUnits: Unit[] = [], deadBuildings: Building[] = []
  for (const [id, entries] of grouped) {
    const entity = [...w.units, ...w.buildings, ...w.transports, ...w.walls.filter(w => w.destructible), ...w.barriers].find(e => e.id === id)
    if (!entity) continue
    const valid = entries.filter(d => d.generation === undefined || ('generation' in entity && entity.generation === d.generation))
    const damage = valid.reduce((sum, d) => sum + d.amount, 0)
    if (!damage) continue
    const actual = Math.min(entity.hp, damage)
    entity.hp = Math.max(0, entity.hp - damage)
    if ('lastDamageTick' in entity) entity.lastDamageTick = w.tick
    const attacker = [...valid].sort((a, b) => b.amount - a.amount || a.sourceId.localeCompare(b.sourceId))[0]
    if ('lastAttackerId' in entity) entity.lastAttackerId = attacker.sourceId
    if ('sellUntil' in entity) entity.sellUntil = null
    for (const d of valid) {
      const p = participant(w, d.sourceOwnerId)
      if (p) p.statistics.damage += actual * d.amount / damage
    }
    if ('kind' in entity && entity.kind === 'fighter') {
      const p = participant(w, entity.ownerId); if (p) p.repair = null
    }
    if (entity.hp <= 0) {
      if ('generation' in entity) { deadUnits.push(entity); const killer = participant(w, attacker.sourceOwnerId); if (killer && entity.kind === 'fighter') killer.statistics.kills++ }
      else if ('padId' in entity) deadBuildings.push(entity)
      else if ('distance' in entity) {
        w.transports = w.transports.filter(t => t.id !== entity.id); w.teams[entity.team].nextTransportTick = w.tick + RULES.transportIntervalTicks
        spatialEvent(w, entity, 'transport-destroyed', entity.id, 16, true)
      } else if ('destructible' in entity) { w.navigationVersion++; spatialEvent(w, { x: (entity.x1 + entity.x2) / 2, z: (entity.z1 + entity.z2) / 2 }, 'wall-destroyed', entity.id, 14) }
      else w.barriers = w.barriers.filter(b => b.id !== entity.id)
    }
  }
  for (const u of deadUnits) removeUnit(w, u)
  for (const b of deadBuildings) removeBuilding(w, b, false)
}
export function finishSales(w: World): void {
  for (const b of [...w.buildings]) if (b.sellUntil !== null && w.tick >= b.sellUntil) removeBuilding(w, b, true)
}
function foundation(w: World, p: Participant, orderId: string): Building | null {
  const order = w.buildOrders.find(o => o.id === orderId)!, map = getMap(w.mapId), pad = map.pads.find(p => p.id === order.padId)!, def = BUILDINGS[order.kind]
  if (order.kind !== 'bridge') {
    const moves: { unit: Unit; point: Point }[] = []
    for (const unit of w.units) if (circleIntersectsRect(unit, unit.radius, pad.rect)) {
      const candidate = closestLegalPoint(unit, unit.radius, map, [...movementObstacles(w, unit.team), pad.rect], 3)
      if (!candidate) return null
      moves.push({ unit, point: candidate })
    }
    for (const { unit, point } of moves) { unit.x = point.x; unit.z = point.z; unit.path = []; unit.pathTarget = null }
  }
  const building: Building = { id: nextId(w, 'building'), ownerId: p.id, team: p.team, kind: order.kind, padId: pad.id, x: pad.x, z: pad.z, hp: def.hp, maxHp: def.hp,
    createdTick: w.tick, completedTick: null, workTicks: 0, connected: false, powered: false, disabledReason: 'construction', sellUntil: null, lastDamageTick: -10000, lastAttackerId: null,
    angle: w.teams[p.team].side === 'L' ? 0 : Math.PI, nextShotExact: 0, targetId: null, targetSinceTick: 0, droneQueue: [], manualAim: null, suppressed: false }
  order.buildingId = building.id; w.buildings.push(building); w.navigationVersion++
  spatialEvent(w, building, 'build-start', building.id, 8)
  return building
}
export function workConstruction(w: World): void {
  const map = getMap(w.mapId)
  for (const p of w.participants) {
    const unit = builder(w, p.id), order = w.buildOrders.find(o => o.ownerId === p.id)
    if (!unit || !order || p.builderPaused) continue
    const pad = map.pads.find(p => p.id === order.padId)!, workPoint = buildWorkPoint(w, unit, pad.id)
    if (!workPoint || distance(unit, workPoint) > 0.28) continue
    const b = order.buildingId ? w.buildings.find(b => b.id === order.buildingId) : foundation(w, p, order.id)
    if (!b || b.createdTick >= w.tick) continue
    b.workTicks++
    if (b.workTicks >= BUILDINGS[b.kind].workTicks) {
      b.completedTick = w.tick; w.buildOrders = w.buildOrders.filter(o => o.id !== order.id); w.navigationVersion++
      spatialEvent(w, b, 'build-finish', b.id, 8)
    }
  }
}
export function workDocks(w: World): void {
  const map = getMap(w.mapId)
  for (const b of w.buildings) if (b.kind === 'dock' && b.powered && b.completedTick !== null && b.completedTick < w.tick && b.droneQueue.length) {
    const order = b.droneQueue[0]
    order.started = true; order.workTicks++
    if (order.workTicks < RULES.droneWorkTicks) continue
    const p = participant(w, b.ownerId)!, obstacles = movementObstacles(w, b.team)
    const spawn = closestLegalPoint({ x: b.x, z: b.z + 1.4 }, RULES.droneRadius, map, obstacles, 3)
    if (!spawn) continue
    const drone = createUnit(w, p, 'drone', spawn); drone.order = { type: 'guard', point: { ...spawn } }
    w.units.push(drone); b.droneQueue.shift()
    teamEvent(w, b.team, { type: 'drone-ready', targetId: drone.id, point: spawn })
  }
}
export function accrueIncome(w: World): void {
  for (const p of w.participants) {
    const rate = 100 + 75 * w.buildings.filter(b => b.ownerId === p.id && b.kind === 'extractor' && b.powered && b.completedTick !== null && b.completedTick < w.tick).length + 25 * w.stations.filter(s => s.owner === p.team).length
    p.incomeRemainder += rate
    const cents = Math.floor(p.incomeRemainder / 30); p.incomeRemainder %= 30
    const before = p.credits; p.credits = Math.min(RULES.maxCredits, Math.round((p.credits + cents / 100) * 100) / 100); p.statistics.income += p.credits - before
  }
  for (const team of Object.values(w.teams)) {
    team.chargeRemainder += 100 + 50 * w.stations.filter(s => s.owner === team.id).length
    const cents = Math.floor(team.chargeRemainder / 30); team.chargeRemainder %= 30
    team.charge = Math.min(RULES.maxCharge, Math.round((team.charge + cents / 100) * 100) / 100)
  }
}
export function spawnPendingUnits(w: World): void {
  const map = getMap(w.mapId)
  for (const p of w.participants) {
    const side = w.teams[p.team].side, base = map.spawns[side][p.seat - 1]
    if (p.respawnAt && w.tick >= p.respawnAt) {
      let at = base, postSpawn = false
      const post = w.buildings.find(b => b.id === p.respawnBuildingId && b.ownerId === p.id && b.kind === 'post' && b.powered && !b.suppressed)
      if (post) {
        const obstacles = movementObstacles(w, p.team)
        for (const r of [1.5, 2, 2.5]) {
          let found = false
          for (let i = 0; i < 8; i++) {
            const point = { x: post.x + r * Math.cos(i * Math.PI / 4), z: post.z + r * Math.sin(i * Math.PI / 4) }
            if (legalPoint(point, RULES.fighterRadius, map, obstacles) && sightClear(w, post, point, post.id, undefined, true)) { at = point; postSpawn = true; found = true; break }
          }
          if (found) break
        }
      }
      const u = createUnit(w, p, 'fighter', at, p.fighterGeneration)
      u.protectedUntil = postSpawn ? w.tick + RULES.spawnProtectionTicks : 0; u.freshSpawn = !postSpawn
      w.units.push(u); p.respawnAt = 0; p.repair = null; p.input.fireHeld = false; p.input.toolHeld = false
      teamEvent(w, p.team, { type: 'respawn', targetId: u.id, point: at })
    }
    if (p.builderRespawnAt && w.tick >= p.builderRespawnAt) {
      w.units.push(createUnit(w, p, 'builder', { x: base.x + (side === 'L' ? 1 : -1), z: base.z + 0.65 }, p.builderGeneration)); p.builderRespawnAt = 0
    }
  }
}
export function prepareUnits(w: World): void {
  const map = getMap(w.mapId)
  for (const u of w.units) {
    const p = participant(w, u.ownerId)!
    if (u.kind === 'fighter') {
      if (insideRect(u, map.protected[w.teams[u.team].side])) {
        u.baseHealTicks++
        if (u.baseHealTicks >= 30) { u.hp = u.maxHp; u.magazine = WEAPONS[p.weapon].magazine; u.reloadUntil = 0 }
      } else {
        u.baseHealTicks = 0
        if (u.freshSpawn) { u.protectedUntil = w.tick + RULES.spawnProtectionTicks; u.freshSpawn = false }
      }
      if (p.pendingLoadout) {
        if (!insideRect(u, map.protected[w.teams[u.team].side])) p.pendingLoadout = null
        else if (w.tick >= p.pendingLoadout.readyTick) { p.weapon = p.pendingLoadout.weapon; p.tool = p.pendingLoadout.tool; p.pendingLoadout = null; u.magazine = WEAPONS[p.weapon].magazine; u.reloadUntil = 0 }
      }
    }
  }
}
export function regenerate(w: World): void {
  const map = getMap(w.mapId)
  for (const u of w.units) {
    if (u.kind === 'fighter' && !insideRect(u, map.protected[w.teams[u.team].side]) && w.tick - u.lastDamageTick >= RULES.fighterRegenDelayTicks) u.hp = Math.min(u.maxHp, u.hp + RULES.fighterRegenPerSecond / 30)
    else if (u.kind === 'drone' && distance(u, map.bases[w.teams[u.team].side]) <= 3) u.hp = Math.min(u.maxHp, u.hp + 10 / 30)
  }
}
