import { RULES } from './constants'
import { clearSegment, closestLegalPoint, distance, findPath, legalPoint, moveSliding, normalize } from './geometry'
import { getMap } from './maps'
import { movementObstacles } from './state'
import { entityVisible, visibleEnemyBuildingIds } from './visibility'
import type { Point, Rect, Unit, World } from './types'

export function walkToward(w: World, u: Unit, target: Point, stopDistance: number, speed: number, physical = movementObstacles(w, u.team)): void {
  const map = getMap(w.mapId)
  if (distance(u, target) <= stopDistance) { u.vx = 0; u.vz = 0; return }
  if (!u.pathTarget || distance(u.pathTarget, target) > 1.5 || u.pathVersion !== w.navigationVersion || (!u.path.length && w.tick >= u.pathRetryTick)) {
    // Physical obstacles are a superset of known obstacles. A fully clear direct segment
    // therefore proves the exact known-only result; otherwise use the original limited view.
    // Unknown obstacles never cause a different route through this shortcut.
    if (legalPoint(target, u.radius, map, physical) && clearSegment(u, target, u.radius, physical)) u.path = [{ x: target.x, z: target.z }]
    else {
      const known = visibleEnemyBuildingIds(w, u.team)
      for (const id of Object.keys(w.memories[u.team])) known.add(id)
      const obstacles = movementObstacles(w, u.team, known)
      u.path = findPath(u, target, u.radius, map, obstacles)
    }
    u.pathTarget = { x: target.x, z: target.z }; u.pathVersion = w.navigationVersion; u.pathRetryTick = w.tick + 30
  }
  while (u.path.length && distance(u, u.path[0]) <= Math.max(0.14, speed / 30)) u.path.shift()
  const next = u.path[0]
  if (!next) { u.vx = 0; u.vz = 0; return }
  const direction = normalize(next.x - u.x, next.z - u.z), move = { x: direction.x * speed / 30, z: direction.z * speed / 30 }
  const position = moveSliding(u, move, u.radius, map, physical)
  u.vx = (position.x - u.x) * 30; u.vz = (position.z - u.z) * 30
  if (distance(u, position) < 0.005 && w.tick >= u.pathRetryTick) { u.path = []; u.pathRetryTick = w.tick + 15 }
  u.x = position.x; u.z = position.z
}
export function orderPoint(w: World, u: Unit): Point | null {
  const map = getMap(w.mapId), order = u.order
  if (order.type === 'move' || order.type === 'guard') return order.point
  if (order.type === 'return') return map.bases[w.teams[u.team].side]
  if (order.type === 'escort') return w.transports.find(t => t.team === u.team) ?? map.depots[w.teams[u.team].side]
  if (order.type === 'capture') return w.stations.find(s => s.id === order.stationId) ?? null
  if (order.type === 'attack') {
    const target = [...w.units, ...w.buildings, ...w.transports].find(e => e.id === order.targetId && (e.team === u.team || ('distance' in e) || entityVisible(w, u.team, e)))
    if (target) { order.lastPoint = { x: target.x, z: target.z }; delete order.lostAt; return target }
    if (order.lostAt === undefined) order.lostAt = -1
    if (order.lastPoint && distance(u, order.lastPoint) <= 0.5 && order.lostAt < 0) order.lostAt = w.tick
    if (order.lostAt >= 0 && w.tick - order.lostAt >= 90) { u.order = { type: 'guard', point: { x: u.x, z: u.z } }; return null }
    return order.lastPoint ?? null
  }
  return null
}
export function buildWorkPoint(w: World, u: Unit, padId: string, physical?: Rect[]): Point | null {
  const map = getMap(w.mapId), pad = map.pads.find(p => p.id === padId)
  if (!pad) return null
  if (pad.workPoint) return pad.workPoint
  const r = pad.rect, obstacle = physical ?? movementObstacles(w, u.team)
  const candidates: Point[] = [
    { x: r.x1 - u.radius - 0.12, z: pad.z }, { x: r.x2 + u.radius + 0.12, z: pad.z },
    { x: pad.x, z: r.z1 - u.radius - 0.12 }, { x: pad.x, z: r.z2 + u.radius + 0.12 },
  ]
  candidates.sort((a, b) => distance(u, a) - distance(u, b) || a.x - b.x || a.z - b.z)
  return candidates.find(p => legalPoint(p, u.radius, map, obstacle)) ?? closestLegalPoint(pad, u.radius, map, obstacle, 2)
}
export function builderMovement(w: World, u: Unit, physical = movementObstacles(w, u.team)): void {
  const p = w.participants.find(p => p.id === u.ownerId)!
  const order = !p.builderPaused ? w.buildOrders.find(o => o.ownerId === p.id) : undefined
  if (order) {
    const target = buildWorkPoint(w, u, order.padId, physical)
    if (target) walkToward(w, u, target, 0.15, RULES.builderSpeed, physical)
  } else {
    const target = orderPoint(w, u)
    if (target) walkToward(w, u, target, 0.25, RULES.builderSpeed, physical)
    else { u.vx = 0; u.vz = 0 }
  }
  if (Math.hypot(u.vx, u.vz) > 0.01) u.angle = Math.atan2(u.vz, u.vx)
}
