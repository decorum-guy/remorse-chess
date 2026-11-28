import { BOT_PROFILES, WEAPONS } from './constants'
import { angleDelta, distance, rotateToward, segmentCapsule, segmentCircle, segmentRect, segmentSegment } from './geometry'
import { getMap } from './maps'
import { randomForBot } from './bots'
import { inBase, participant } from './state'
import { entityVisible, isPointVisible, ownEvent, shotEvent, sightClear, teamEvent, visibleEnemyIds } from './visibility'
import type { Building, Participant, Point, Team, Transport, Unit, Weapon, World } from './types'

export interface Damage { targetId: string; amount: number; sourceId: string; sourceOwnerId: string; sourceTeam: Team; generation?: number }
type Source = Point & { id: string; team: Team; ownerId: string; order?: Unit['order'] }
type Hit = { id: string; type: 'unit' | 'building' | 'transport' | 'wall' | 'barrier' | 'solid'; fraction: number; point: Point; generation?: number }
export function raycast(w: World, source: Source, end: Point): Hit | null {
  const map = getMap(w.mapId)
  let hit: Hit | null = null
  const test = (fraction: number | null, id: string, type: Hit['type'], generation?: number): void => {
    if (fraction === null || fraction < 0 || fraction > 1 || (hit && (fraction > hit.fraction || (fraction === hit.fraction && id.localeCompare(hit.id) >= 0)))) return
    hit = { id, type, fraction, point: { x: source.x + (end.x - source.x) * fraction, z: source.z + (end.z - source.z) * fraction }, ...(generation !== undefined ? { generation } : {}) }
  }
  for (const wall of w.walls) if (!wall.destructible || wall.hp > 0) test(segmentRect(source, end, wall), wall.id, wall.destructible ? 'wall' : 'solid')
  for (const b of w.buildings) if (b.id !== source.id && b.kind !== 'bridge') test(segmentRect(source, end, map.pads.find(p => p.id === b.padId)!.rect), b.id, b.team === source.team ? 'solid' : 'building')
  for (const b of w.buildings) if (b.id !== source.id && b.kind === 'bridge' && b.team !== source.team) test(segmentRect(source, end, map.pads.find(p => p.id === b.padId)!.rect), b.id, 'building')
  for (const barrier of w.barriers) test(segmentSegment(source, end, barrier.a, barrier.b), barrier.id, barrier.team === source.team ? 'solid' : 'barrier')
  for (const team of ['A', 'B'] as Team[]) test(segmentRect(source, end, map.protected[w.teams[team].side]), `base-${team}`, 'solid')
  for (const u of w.units) if (u.id !== source.id && u.team !== source.team && u.hp > 0) test(segmentCircle(source, end, u, u.radius), u.id, 'unit', u.generation)
  for (const t of w.transports) if (t.team !== source.team) test(segmentCapsule(source, end, t, t.angle), t.id, 'transport')
  return hit
}
function historicalHit(w: World, source: Unit, end: Point, rewindTicks: number): Hit | null {
  if (!rewindTicks) return null
  const frame = w.history.find(f => f.tick === w.tick - rewindTicks), oldSource = frame?.units.find(u => u.id === source.id && u.generation === source.generation)
  if (!frame || !oldSource || inBase(w, oldSource, source.team)) return null
  const oldEnd = { x: oldSource.x + end.x - source.x, z: oldSource.z + end.z - source.z }
  let first: Hit | null = null, solid = 1
  for (const r of frame.blockers) { const t = segmentRect(oldSource, oldEnd, r); if (t !== null) solid = Math.min(solid, t) }
  for (const barrier of frame.barriers ?? []) { const t = segmentSegment(oldSource, oldEnd, barrier.a, barrier.b); if (t !== null) solid = Math.min(solid, t) }
  const visibleNow = visibleEnemyIds(w, source.team)
  for (const historical of frame.units) {
    const current = w.units.find(u => u.id === historical.id && u.generation === historical.generation)
    if (!current || historical.team === source.team || (historical.protectedUntil ?? 0) > frame.tick || inBase(w, historical, historical.team) || !frame.visible[source.team].includes(historical.id) || !visibleNow.has(historical.id)) continue
    const t = segmentCircle(oldSource, oldEnd, historical, historical.radius)
    if (t !== null && t < solid && (!first || t < first.fraction)) first = { id: historical.id, type: 'unit', fraction: t, point: { x: oldSource.x + (oldEnd.x - oldSource.x) * t, z: oldSource.z + (oldEnd.z - oldSource.z) * t }, generation: historical.generation }
  }
  return first
}
export function chooseTarget(w: World, source: Source, range: number, kind: 'fighter' | 'drone' | 'turret' | 'battery', lastAttackerId: string | null = null): Unit | Building | Transport | null {
  const candidates = [...w.units, ...w.buildings, ...w.transports].filter(e => {
    if (e.team === source.team || distance(source, e) > range || ('protectedUntil' in e && (e.protectedUntil > w.tick || inBase(w, e, e.team)))) return false
    if (kind === 'battery' && !('distance' in e) && !('padId' in e)) return false
    return ('distance' in e ? isPointVisible(w, source.team, e, e.id) : entityVisible(w, source.team, e)) && sightClear(w, source, e, source.id, e.id, true)
  })
  const orderedTargetId = source.order?.type === 'attack' ? source.order.targetId : null
  if ((kind === 'fighter' || kind === 'drone') && orderedTargetId) {
    const orderedTarget = candidates.find(e => e.id === orderedTargetId)
    if (orderedTarget) return orderedTarget
  }
  const rank = (e: Unit | Building | Transport): number => {
    if (kind === 'battery') return 'distance' in e ? 0 : 1
    if (kind === 'turret' && e.id === lastAttackerId) return -1
    return 'kind' in e ? e.kind === 'fighter' ? 0 : e.kind === 'drone' || e.kind === 'builder' ? 1 : 3 : 2
  }
  return candidates.sort((a, b) => rank(a) - rank(b) || distance(source, a) - distance(source, b) || a.id.localeCompare(b.id))[0] ?? null
}
function assistedAngle(w: World, u: Unit, angle: number, range: number): number {
  const candidates = [...w.units, ...w.buildings, ...w.transports].filter(e => e.team !== u.team && distance(u, e) <= range && ('distance' in e ? isPointVisible(w, u.team, e, e.id) : entityVisible(w, u.team, e)))
    .map(e => ({ e, delta: angleDelta(angle, Math.atan2(e.z - u.z, e.x - u.x)) })).filter(v => Math.abs(v.delta) <= 8 * Math.PI / 180)
    .sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || distance(u, a.e) - distance(u, b.e) || a.e.id.localeCompare(b.e.id))
  return candidates.length ? angle + Math.max(-3 * Math.PI / 180, Math.min(3 * Math.PI / 180, candidates[0].delta)) : angle
}
function fire(w: World, source: Source & { angle: number }, damage: number, range: number, damageEvents: Damage[], label: string, options: { weapon?: Weapon; unit?: Unit; battery?: boolean } = {}): void {
  const p = participant(w, source.ownerId), weapon = options.weapon
  const baseAngle = options.unit && p?.input.assist && p.mode === 'fighter' ? assistedAngle(w, options.unit, source.angle, range) : source.angle
  const offsets = weapon ? WEAPONS[weapon].pellets : [0]
  const impacts = new Map<string, { amount: number; point: Point; visible: boolean; team?: Team }>()
  for (const degrees of offsets) {
    const angle = baseAngle + degrees * Math.PI / 180, end = { x: source.x + Math.cos(angle) * range, z: source.z + Math.sin(angle) * range }
    const rewound = options.unit ? historicalHit(w, options.unit, end, w.rewindTicks[source.ownerId] ?? 0) : null
    const hit = rewound ?? raycast(w, source, end)
    shotEvent(w, source, end, label)
    if (!hit) continue
    if (hit.type === 'solid') {
      if (w.walls.some(r => r.id === hit.id) || isPointVisible(w, source.team, hit.point, hit.id)) ownEvent(w, source.ownerId, { type: 'blocked', point: hit.point, targetId: hit.id })
      continue
    }
    const targetUnit = w.units.find(u => u.id === hit.id)
    if (targetUnit && (targetUnit.protectedUntil > w.tick || inBase(w, targetUnit, targetUnit.team) || options.battery)) continue
    let amount = damage
    if (weapon === 'shotgun') { const d = distance(source, hit.point); amount = d <= 5 ? 8 : Math.max(3, Math.floor(8 - 5 * (d - 5) / 6)) }
    damageEvents.push({ targetId: hit.id, amount, sourceId: source.id, sourceOwnerId: source.ownerId, sourceTeam: source.team, ...(hit.generation !== undefined ? { generation: hit.generation } : {}) })
    const target = [...w.units, ...w.buildings, ...w.transports].find(e => e.id === hit.id)
    const visible = target ? ('distance' in target) || entityVisible(w, source.team, target) : isPointVisible(w, source.team, hit.point, hit.id)
    const impact = impacts.get(hit.id)
    if (impact) impact.amount += amount
    else impacts.set(hit.id, { amount, point: { x: hit.point.x, z: hit.point.z }, visible, ...(target ? { team: target.team } : {}) })
  }
  // A shotgun trigger is one shot: all pellets on the same object share one hit/hurt event.
  for (const [targetId, impact] of impacts) {
    if (impact.visible) ownEvent(w, source.ownerId, { type: 'hit', targetId, point: impact.point, value: impact.amount })
    if (impact.team) teamEvent(w, impact.team, { type: 'hurt', targetId, point: impact.point, value: impact.amount })
  }
}
export function fireFighter(w: World, p: Participant, u: Unit, damageEvents: Damage[], autonomous: boolean): void {
  const def = WEAPONS[p.weapon]
  if (u.reloadUntil && w.tick >= u.reloadUntil) { u.reloadUntil = 0; u.magazine = def.magazine; ownEvent(w, p.id, { type: 'reload-finish', actorId: u.id }) }
  if (u.magazine === 0 && !u.reloadUntil) { u.reloadUntil = w.tick + def.reloadTicks; ownEvent(w, p.id, { type: 'reload-start', actorId: u.id }) }
  let trigger = false
  if (autonomous) {
    const target = chooseTarget(w, u, def.range, 'fighter')
    if (target) {
      if (u.targetId !== target.id) { u.targetId = target.id; u.targetSinceTick = w.tick }
      const level = p.controller === 'human' ? 'normal' : p.botLevel, profile = BOT_PROFILES[level]
      if (w.tick >= p.aimErrorUntil) { p.aimError = (randomForBot(p) * 2 - 1) * profile.errorDegrees * Math.PI / 180; p.aimErrorUntil = w.tick + 9 }
      u.angle = Math.atan2(target.z - u.z, target.x - u.x) + p.aimError
      trigger = w.tick - u.targetSinceTick >= profile.reactionTicks
    } else u.targetId = null
  } else {
    u.angle = Math.atan2(p.input.aimZ, p.input.aimX)
    const press = p.input.firePressSeq > p.consumedFirePressSeq
    if (press) p.consumedFirePressSeq = p.input.firePressSeq
    trigger = p.input.fireHeld || press
  }
  if (!trigger || u.reloadUntil > w.tick || !u.magazine || w.tick < Math.ceil(u.nextShotExact) || inBase(w, u, p.team) || p.pendingLoadout) return
  u.protectedUntil = 0; u.magazine--; u.shotSerial++
  u.nextShotExact = (u.nextShotExact > w.tick - 1 ? u.nextShotExact : w.tick) + def.interval * 30
  fire(w, u, def.damage, def.range, damageEvents, p.weapon, { weapon: p.weapon, unit: u })
}
export function fireAutomated(w: World, source: Unit | Building, damageEvents: Damage[]): void {
  const kind = source.kind
  if (kind !== 'drone' && kind !== 'turret' && kind !== 'battery') return
  if ('powered' in source && (!source.powered || source.completedTick === null || source.completedTick >= w.tick)) return
  const battery = kind === 'battery', range = battery ? 36 : 14
  const target = chooseTarget(w, source, range, kind, source.lastAttackerId)
  const manual = battery && 'manualAim' in source ? source.manualAim : null
  let desired: number | null = null
  if (manual) desired = Math.atan2(manual.z, manual.x)
  else if (target) {
    if (source.targetId !== target.id) { source.targetId = target.id; source.targetSinceTick = w.tick }
    desired = Math.atan2(target.z - source.z, target.x - source.x)
  } else source.targetId = null
  if (desired === null) return
  source.angle = rotateToward(source.angle, desired, (battery ? Math.PI / 2 : Math.PI) / 30)
  if ((!manual && w.tick - source.targetSinceTick < 8) || Math.abs(angleDelta(source.angle, desired)) > Math.PI / 60 || w.tick < Math.ceil(source.nextShotExact)) return
  source.nextShotExact = (source.nextShotExact > w.tick - 1 ? source.nextShotExact : w.tick) + (battery ? 30 : 7.5)
  fire(w, source, battery ? 60 : kind === 'turret' ? 8 : 6, range, damageEvents, kind, { battery })
}
