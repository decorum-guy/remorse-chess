import { RULES } from './constants'
import { closestLegalPoint, findPath, legalPoint, rectsIntersect, segmentRect } from './geometry'
import { routeLength } from './maps'
import type { MapData, Rect, Side } from './types'

export interface MapValidation { ok: boolean; errors: string[]; routeLengths: Record<Side, Record<'N' | 'S', number>> }
export function validateMap(map: MapData): MapValidation {
  const errors: string[] = [], ids = new Set<string>()
  const objects = [...map.pads, ...map.walls, ...map.stations]
  for (const o of objects) { if (ids.has(o.id)) errors.push(`duplicate:${o.id}`); ids.add(o.id) }
  const within = (r: Rect): boolean => r.x1 >= 1 && r.z1 >= 1 && r.x2 <= map.width - 1 && r.z2 <= map.height - 1 && r.x1 < r.x2 && r.z1 < r.z2
  for (const [i, r] of [...map.water, ...map.walls, ...map.pads.map(p => p.rect)].entries()) if (!within(r)) errors.push(`bounds:${i}`)
  for (const pad of map.pads) {
    if (pad.kind === 'bridge') {
      if (!map.water.some(w => pad.rect.x1 >= w.x1 && pad.rect.x2 <= w.x2 && pad.rect.z1 >= w.z1 && pad.rect.z2 <= w.z2)) errors.push(`bridge-water:${pad.id}`)
    } else {
      const area = { x1: pad.x - 1, z1: pad.z - 1, x2: pad.x + 1, z2: pad.z + 1 }
      if (map.water.some(w => rectsIntersect(area, w))) errors.push(`pad-water:${pad.id}`)
      if (map.walls.some(w => rectsIntersect(area, w))) errors.push(`pad-wall:${pad.id}`)
    }
  }
  const lengths = { L: { N: 0, S: 0 }, R: { N: 0, S: 0 } }
  for (const side of ['L', 'R'] as Side[]) for (const route of ['N', 'S'] as const) {
    const path = map.routes[side][route]
    lengths[side][route] = routeLength(path)
    if (Math.abs(lengths[side][route] - map.routeLengths[route]) > 1e-6) errors.push(`route-length:${side}:${route}`)
    if (path.length < 2 || path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.z) || p.x < 1 || p.z < 1 || p.x > map.width - 1 || p.z > map.height - 1)) errors.push(`route-points:${side}:${route}`)
    for (let i = 1; i < path.length; i++) for (const [j, obstacle] of [...map.walls, ...map.water, ...map.pads.filter(p => p.kind === 'ground').map(p => p.rect)].entries()) {
      if (segmentRect(path[i - 1], path[i], obstacle, 1.5) !== null) errors.push(`route-reserve:${side}:${route}:${i}:${j}`)
    }
  }
  const maxObstacles = [...map.walls, ...map.water, ...map.pads.filter(p => p.kind === 'ground').map(p => p.rect)]
  for (const side of ['L', 'R'] as Side[]) {
    const obstacles = [...maxObstacles, map.protected[side === 'L' ? 'R' : 'L']]
    for (const [i, target] of [...map.stations, map.complex].entries()) if (!findPath(map.spawns[side][0], target, RULES.fighterRadius, map, obstacles).length) errors.push(`no-full-map-path:${side}:${i}`)
    const base = map.bases[side], exits = [{ x: base.x, z: map.protected[side].z1 - 1 }, { x: base.x, z: map.protected[side].z2 + 1 }]
    if (exits.filter(p => legalPoint(p, RULES.fighterRadius, map, obstacles) && findPath(map.spawns[side][0], p, RULES.fighterRadius, map, obstacles).length).length < 2) errors.push(`base-exits:${side}`)
    for (const pad of map.pads.filter(p => p.side === side)) {
      const obstacles = [...map.walls, ...map.water, map.protected[side === 'L' ? 'R' : 'L']]
      const target = pad.workPoint ?? pad
      if (!findPath(map.spawns[side][0], target, RULES.builderRadius, map, obstacles).length) errors.push(`builder-pad:${pad.id}`)
    }
  }
  for (const pad of map.pads.filter(p => p.kind === 'bridge')) {
    for (let x = pad.rect.x1; x <= pad.rect.x2; x += 0.5) for (let z = pad.rect.z1; z <= pad.rect.z2; z += 0.5) {
      if (!closestLegalPoint({ x, z }, RULES.fighterRadius, map, maxObstacles, 10, p => p.x + RULES.fighterRadius < pad.rect.x1 || p.x - RULES.fighterRadius > pad.rect.x2)) errors.push(`bridge-bank:${pad.id}:${x}:${z}`)
    }
  }
  return { ok: errors.length === 0, errors, routeLengths: lengths }
}
