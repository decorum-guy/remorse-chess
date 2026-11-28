import { BUILDINGS, RULES, WEAPONS } from './constants'
import { distance, insideRect, segmentRect } from './geometry'
import { getMap } from './maps'
import { fighter, inBase, isCombat, lineBlockers, networkCovers, nextId, participant } from './state'
import { entityVisible, ownEvent, sightClear, spatialEvent, teamEvent } from './visibility'
import type { Action, ActionResult, Building, BuildingKind, BuildOption, Participant, Point, Refund, World } from './types'

const ok = (entityId?: string, refund?: Refund): ActionResult => ({ ok: true, code: 'ok', ...(entityId ? { entityId } : {}), ...(refund ? { refund } : {}) })
const no = (code: string): ActionResult => ({ ok: false, code })
const validPoint = (v: unknown): v is Point => !!v && typeof v === 'object' && Number.isFinite((v as Point).x) && Number.isFinite((v as Point).z)
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}
function safePayload(value: unknown, depth = 0): boolean {
  if (depth > 8) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.length <= 500
  if (value === null || typeof value === 'boolean' || value === undefined) return true
  if (typeof value !== 'object') return false
  const entries = Object.entries(value)
  return entries.length <= 30 && entries.every(([key, v]) => !['__proto__', 'prototype', 'constructor'].includes(key) && safePayload(v, depth + 1))
}
export function refundPreview(p: Pick<Participant, 'credits'>, calculated: number): Refund {
  const credited = Math.min(calculated, Math.max(0, Math.round((RULES.maxCredits - p.credits) * 100) / 100))
  return { calculated, credited, lost: Math.round((calculated - credited) * 100) / 100 }
}
export function creditRefund(w: World, p: Participant, calculated: number, reason: string): Refund {
  const result = refundPreview(p, calculated)
  p.credits = Math.round((p.credits + result.credited) * 100) / 100
  p.refunds.push({ ...result, tick: w.tick, reason })
  if (p.refunds.length > 30) p.refunds.shift()
  ownEvent(w, p.id, { type: 'refund', refund: result, label: reason })
  return result
}
export const sellRefund = (building: Building): number => Math.floor(BUILDINGS[building.kind].cost * 0.5 * building.hp / building.maxHp)
export function buildEligibility(w: World, ownerId: string, padId: string, kind: BuildingKind): BuildOption {
  const def = Object.hasOwn(BUILDINGS, kind) ? BUILDINGS[kind] : undefined, p = participant(w, ownerId), pad = getMap(w.mapId).pads.find(p => p.id === padId)
  const basic = { kind, cost: def?.cost ?? 0, workTicks: def?.workTicks ?? 0, power: def?.power ?? 0, willBePowered: false }
  const fail = (code: string): BuildOption => ({ ...basic, ok: false, code })
  if (!p || !def || !pad) return fail('invalid-target')
  if (!['preparation', 'battle', 'overtime'].includes(w.phase)) return fail('phase')
  if (pad.side !== w.teams[p.team].side) return fail('own-side-only')
  if ((kind === 'bridge') !== (pad.kind === 'bridge')) return fail('pad-type')
  if (w.buildings.some(b => b.padId === padId) || w.buildOrders.some(o => o.padId === padId)) return fail('pad-occupied')
  const owned = w.buildings.filter(b => b.ownerId === ownerId), unstarted = w.buildOrders.filter(o => o.ownerId === ownerId && !o.buildingId)
  if (owned.length + unstarted.length >= RULES.maxBuildings) return fail('building-limit')
  if (owned.filter(b => b.kind === kind).length + unstarted.filter(o => o.kind === kind).length >= def.limit) return fail('type-limit')
  if (w.buildOrders.filter(o => o.ownerId === ownerId).length >= RULES.maxBuildOrders) return fail('queue-full')
  if (p.credits < def.cost) return fail('credits')
  if (!networkCovers(w, p.team, pad.workPoint ?? pad)) return fail('network')
  let willBePowered = ['relay', 'generator', 'bridge'].includes(kind)
  if (!willBePowered) {
    const candidate = { id: 'preview-new-building', kind, createdTick: w.tick + 1 }, consumers = [...owned.filter(b => b.connected && b.completedTick !== null && !['relay', 'generator', 'bridge'].includes(b.kind)), candidate]
    const priority = (b: { id: string; kind: BuildingKind }): number => p.priority.includes(b.id) ? p.priority.indexOf(b.id) : 100 + RULES.powerOrder.indexOf(b.kind)
    let remaining = p.power - owned.filter(b => b.kind === 'relay' && b.powered).length
    for (const b of consumers.sort((a, b) => priority(a) - priority(b) || a.createdTick - b.createdTick || a.id.localeCompare(b.id))) {
      const cost = BUILDINGS[b.kind].power
      if (cost > remaining) continue
      remaining -= cost; if (b === candidate) willBePowered = true
    }
  }
  return { ...basic, ok: true, code: 'ok', willBePowered }
}
export function startReload(w: World, p: Participant): ActionResult {
  const u = fighter(w, p.id)
  if (!u) return no('fighter-dead')
  if (u.reloadUntil > w.tick) return no('reloading')
  if (u.magazine >= WEAPONS[p.weapon].magazine) return no('magazine-full')
  u.reloadUntil = w.tick + WEAPONS[p.weapon].reloadTicks
  ownEvent(w, p.id, { type: 'reload-start', actorId: u.id })
  return ok()
}
export function useTool(w: World, p: Participant, point?: Point, targetId?: string): ActionResult {
  const u = fighter(w, p.id)
  if (!isCombat(w)) return no('phase')
  if (!u) return no('fighter-dead')
  if (inBase(w, u, p.team)) return no('protected-base')
  if (p.toolReadyTick > w.tick) return no('tool-cooldown')
  if (p.tool === 'repair') {
    const target = [...w.buildings, ...w.transports, ...w.units.filter(u => u.kind === 'drone')].find(e => e.id === targetId && e.team === p.team)
    if (!target || target.hp >= target.maxHp || distance(u, target) > RULES.repairRange || !sightClear(w, u, target, u.id, target.id)) return no('invalid-target')
    p.repair = { targetId: target.id, untilTick: w.tick + RULES.repairTicks, started: false }
    u.protectedUntil = 0; p.input.toolHeld = true
    return ok(target.id)
  }
  if (p.tool === 'smoke') {
    const dest = point ?? { x: u.x + Math.cos(u.angle) * RULES.smokeRange, z: u.z + Math.sin(u.angle) * RULES.smokeRange }
    const map = getMap(w.mapId)
    if (!validPoint(dest) || distance(u, dest) > RULES.smokeRange + 1e-6 || dest.x < 1 || dest.z < 1 || dest.x > map.width - 1 || dest.z > map.height - 1 || !sightClear(w, u, dest, u.id, undefined, true)) return no('tool-position')
    const id = nextId(w, 'smoke')
    w.smokes.push({ id, ownerId: p.id, team: p.team, x: dest.x, z: dest.z, radius: RULES.smokeRadius, expiresTick: w.tick + RULES.smokeTicks })
    p.toolReadyTick = w.tick + RULES.smokeCooldownTicks; u.protectedUntil = 0
    spatialEvent(w, dest, 'tool-smoke', id, 8)
    return ok(id)
  }
  const center = { x: u.x + Math.cos(u.angle) * RULES.barrierDistance, z: u.z + Math.sin(u.angle) * RULES.barrierDistance }
  const tangent = { x: -Math.sin(u.angle), z: Math.cos(u.angle) }, blockers = lineBlockers(w)
  const map = getMap(w.mapId)
  if (center.x <= 1 || center.z <= 1 || center.x >= map.width - 1 || center.z >= map.height - 1 || blockers.some(r => insideRect(center, r))) return no('tool-position')
  let left = 2, right = 2
  for (const [coordinate, direction, lo, hi] of [[center.x, tangent.x, 1, map.width - 1], [center.z, tangent.z, 1, map.height - 1]]) {
    if (direction > 0) { left = Math.min(left, (coordinate - lo) / direction); right = Math.min(right, (hi - coordinate) / direction) }
    if (direction < 0) { left = Math.min(left, (hi - coordinate) / -direction); right = Math.min(right, (coordinate - lo) / -direction) }
  }
  for (const r of blockers) {
    const a = segmentRect(center, { x: center.x - tangent.x * 2, z: center.z - tangent.z * 2 }, r)
    const b = segmentRect(center, { x: center.x + tangent.x * 2, z: center.z + tangent.z * 2 }, r)
    if (a !== null) left = Math.min(left, Math.max(0, a * 2 - 0.005))
    if (b !== null) right = Math.min(right, Math.max(0, b * 2 - 0.005))
  }
  if (left + right < 1) return no('tool-position')
  const id = nextId(w, 'barrier')
  w.barriers.push({ id, ownerId: p.id, team: p.team, a: { x: center.x - tangent.x * left, z: center.z - tangent.z * left }, b: { x: center.x + tangent.x * right, z: center.z + tangent.z * right }, hp: RULES.barrierHp, expiresTick: w.tick + RULES.barrierTicks })
  p.toolReadyTick = w.tick + RULES.barrierCooldownTicks; u.protectedUntil = 0
  spatialEvent(w, center, 'tool-barrier', id, 8)
  return ok(id)
}
export function applyAction(w: World, ownerId: string, raw: unknown): ActionResult {
  const p = participant(w, ownerId)
  if (!p || !raw || typeof raw !== 'object' || Array.isArray(raw) || !safePayload(raw)) return no('invalid-action')
  const action = raw as Action
  if (typeof action.type !== 'string' || (action.actionId !== undefined && (typeof action.actionId !== 'string' || !action.actionId || action.actionId.length > 120))) return no('invalid-action')
  const fields: Record<string, string[]> = { mode: ['mode'], loadout: ['weapon', 'tool'], reload: [], tool: ['point', 'targetId'], build: ['padId', 'kind'], cancelBuild: ['orderId'], reorderBuild: ['orderIds'], resumeBuild: [], sell: ['buildingId'], cancelSell: ['buildingId'], produceDrone: ['buildingId'], cancelDrone: ['buildingId', 'orderId'], priority: ['buildingIds'], order: ['unitIds', 'order'], route: ['route'], respawn: ['buildingId'], batteryAim: ['buildingId', 'direction'], ping: ['ping', 'point'] }
  if (!Object.hasOwn(fields, action.type) || Object.keys(action).some(key => !['type', 'actionId', ...fields[action.type]].includes(key))) return no('invalid-action')
  const payload = canonical(action), key = action.actionId ? `${ownerId}|${action.actionId}` : null
  if (key && w.receipts[key]) return w.receipts[key].payload === payload ? { ...w.receipts[key].result } : no('action-id-conflict')
  let result: ActionResult
  try { result = apply(w, p, action) } catch { result = no('invalid-action') }
  if (key) w.receipts[key] = { payload, result: { ...result } }
  return result
}
function apply(w: World, p: Participant, action: Action): ActionResult {
  const u = fighter(w, p.id)
  if (w.phase === 'finished') return no('match-finished')
  switch (action.type) {
    case 'mode':
      if (!['fighter', 'tactics'].includes(action.mode)) return no('invalid-action')
      p.mode = action.mode; p.input.fireHeld = false; p.input.moveX = 0; p.input.moveZ = 0; p.repair = null
      if (u) { u.targetId = null; u.path = []; if (action.mode === 'tactics' && !u.explicitOrder) u.order = { type: 'guard', point: { x: u.x, z: u.z } } }
      return ok()
    case 'reload': return startReload(w, p)
    case 'loadout': {
      const weapon = action.weapon ?? p.weapon, tool = action.tool ?? p.tool
      if (!Object.hasOwn(WEAPONS, weapon) || !['barrier', 'smoke', 'repair'].includes(tool)) return no('invalid-action')
      if (w.phase === 'preparation' || !u) { p.weapon = weapon; p.tool = tool; if (u) u.magazine = WEAPONS[weapon].magazine; return ok() }
      if (!inBase(w, u, p.team)) return no('base-only')
      p.pendingLoadout = { weapon, tool, readyTick: w.tick + 30 }; u.reloadUntil = 0
      return ok()
    }
    case 'tool': return useTool(w, p, action.point, action.targetId)
    case 'build': {
      const eligibility = buildEligibility(w, p.id, action.padId, action.kind)
      if (!eligibility.ok) return no(eligibility.code)
      const id = nextId(w, 'order')
      p.credits -= eligibility.cost; p.statistics.spent += eligibility.cost; p.builderPaused = false
      w.buildOrders.push({ id, ownerId: p.id, padId: action.padId, kind: action.kind, createdTick: w.tick, buildingId: null })
      ownEvent(w, p.id, { type: 'build-ordered', targetId: id, value: eligibility.cost })
      return ok(id)
    }
    case 'cancelBuild': {
      const order = w.buildOrders.find(o => o.id === action.orderId && o.ownerId === p.id)
      if (!order) return no('invalid-target')
      if (order.buildingId) return apply(w, p, { type: 'sell', buildingId: order.buildingId })
      w.buildOrders = w.buildOrders.filter(o => o.id !== order.id)
      return ok(order.id, creditRefund(w, p, BUILDINGS[order.kind].cost, 'build-cancelled'))
    }
    case 'reorderBuild': {
      if (!Array.isArray(action.orderIds) || action.orderIds.some(id => typeof id !== 'string')) return no('invalid-action')
      const owned = w.buildOrders.filter(o => o.ownerId === p.id)
      if (action.orderIds.length !== owned.length || new Set(action.orderIds).size !== owned.length || action.orderIds.some(id => !owned.some(o => o.id === id))) return no('invalid-action')
      const started = owned.find(o => o.buildingId)
      if (started && action.orderIds[0] !== started.id) return no('building-in-progress')
      w.buildOrders = [...w.buildOrders.filter(o => o.ownerId !== p.id), ...action.orderIds.map(id => owned.find(o => o.id === id)!)]
      p.builderPaused = false
      return ok()
    }
    case 'resumeBuild':
      if (!w.buildOrders.some(o => o.ownerId === p.id)) return no('queue-empty')
      p.builderPaused = false; return ok()
    case 'sell': {
      const b = w.buildings.find(b => b.id === action.buildingId && b.ownerId === p.id)
      if (!b) return no('invalid-target')
      if (b.sellUntil !== null) return no('selling')
      if (w.tick - b.lastDamageTick < RULES.sellDamageQuietTicks) return no('recent-damage')
      b.sellUntil = w.tick + RULES.sellTicks
      return ok(b.id, refundPreview(p, sellRefund(b)))
    }
    case 'cancelSell': {
      const b = w.buildings.find(b => b.id === action.buildingId && b.ownerId === p.id)
      if (!b || b.sellUntil === null) return no('invalid-target')
      b.sellUntil = null; return ok(b.id)
    }
    case 'produceDrone': {
      const b = w.buildings.find(b => b.id === action.buildingId && b.ownerId === p.id && b.kind === 'dock' && b.completedTick !== null)
      if (!b) return no('invalid-target')
      if (b.droneQueue.length >= 2) return no('queue-full')
      if (w.units.filter(u => u.ownerId === p.id && u.kind === 'drone').length + w.buildings.filter(b => b.ownerId === p.id).reduce((n, b) => n + b.droneQueue.length, 0) >= RULES.maxDrones) return no('drone-limit')
      if (p.credits < RULES.droneCost) return no('credits')
      p.credits -= RULES.droneCost; p.statistics.spent += RULES.droneCost
      const id = nextId(w, 'drone-order'); b.droneQueue.push({ id, ownerId: p.id, started: false, workTicks: 0 })
      return ok(id)
    }
    case 'cancelDrone': {
      const b = w.buildings.find(b => b.id === action.buildingId && b.ownerId === p.id), order = b?.droneQueue.find(o => o.id === action.orderId)
      if (!b || !order) return no('invalid-target')
      b.droneQueue = b.droneQueue.filter(o => o.id !== order.id)
      return ok(order.id, creditRefund(w, p, order.started ? 30 : 60, 'drone-cancelled'))
    }
    case 'priority':
      if (!Array.isArray(action.buildingIds) || new Set(action.buildingIds).size !== action.buildingIds.length || action.buildingIds.some(id => !w.buildings.some(b => b.id === id && b.ownerId === p.id && !['relay', 'generator', 'bridge'].includes(b.kind)))) return no('invalid-target')
      p.priority = [...action.buildingIds]; return ok()
    case 'order': {
      if (!Array.isArray(action.unitIds) || !action.unitIds.length || action.unitIds.length > 4 || !action.order || !['move', 'guard', 'attack', 'capture', 'escort', 'return', 'stop'].includes(action.order.type)) return no('invalid-action')
      const owned = action.unitIds.map(id => w.units.find(u => u.id === id && u.ownerId === p.id))
      if (owned.some(u => !u)) return no('invalid-target')
      const order = structuredClone(action.order)
      const orderFields: Record<string, string[]> = { move: ['point'], guard: ['point'], attack: ['targetId'], capture: ['stationId'], escort: [], return: [], stop: [] }
      if (Object.keys(order).some(key => !['type', ...orderFields[order.type]].includes(key))) return no('invalid-action')
      if ((order.type === 'move' || order.type === 'guard') && (!validPoint(order.point) || order.point.x < 1 || order.point.z < 1 || order.point.x > getMap(w.mapId).width - 1 || order.point.z > getMap(w.mapId).height - 1)) return no('invalid-target')
      if (order.type === 'attack') {
        const target = [...w.units, ...w.buildings, ...w.transports].find(e => e.id === order.targetId && e.team !== p.team)
        if (!target || (!w.transports.some(t => t.id === target.id) && !entityVisible(w, p.team, target as UnitOrBuilding))) return no('invalid-target')
        order.lastPoint = { x: target.x, z: target.z }; delete order.lostAt
      }
      if (order.type === 'capture' && !w.stations.some(s => s.id === order.stationId)) return no('invalid-target')
      for (const entity of owned) if (entity) { entity.order = structuredClone(order); entity.explicitOrder = true; entity.path = []; entity.pathTarget = null; if (entity.kind === 'builder') p.builderPaused = true }
      teamEvent(w, p.team, { type: 'order', actorId: p.id, label: order.type })
      return ok()
    }
    case 'route': {
      if (action.route !== 'N' && action.route !== 'S') return no('invalid-action')
      const team = w.teams[p.team]
      if (w.tick - team.routeChangedTick < 90) return no('route-cooldown')
      team.manualRoute = action.route; team.routeChangedTick = w.tick; team.routeAuthorId = p.id
      if (p.controller === 'human' && !p.temporaryBot) team.humanRouteTick = w.tick
      teamEvent(w, p.team, { type: 'route', actorId: p.id, label: action.route })
      return ok()
    }
    case 'respawn':
      if (action.buildingId !== null && !w.buildings.some(b => b.id === action.buildingId && b.ownerId === p.id && b.kind === 'post')) return no('invalid-target')
      p.respawnBuildingId = action.buildingId; return ok()
    case 'batteryAim': {
      const b = w.buildings.find(b => b.id === action.buildingId && b.ownerId === p.id && b.kind === 'battery')
      if (!b || (action.direction !== null && (!validPoint(action.direction) || Math.hypot(action.direction.x, action.direction.z) < 0.001))) return no('invalid-target')
      b.manualAim = action.direction; p.mode = 'tactics'; return ok()
    }
    case 'ping':
      if (!['escort', 'help', 'build', 'north', 'south'].includes(action.ping) || (action.point && !validPoint(action.point))) return no('invalid-action')
      if (action.point && (action.point.x < 1 || action.point.z < 1 || action.point.x > getMap(w.mapId).width - 1 || action.point.z > getMap(w.mapId).height - 1)) return no('invalid-target')
      teamEvent(w, p.team, { type: 'ping', actorId: p.id, label: action.ping, ...(action.point ? { point: action.point } : {}) }); return ok()
    default: return no('invalid-action')
  }
}
type UnitOrBuilding = Parameters<typeof entityVisible>[2]
