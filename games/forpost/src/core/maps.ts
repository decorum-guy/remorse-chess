import { MAP_VERSION } from './constants'
import type { MapData, MapId, Point, Rect, Side } from './types'

const point = (x: number, z: number): Point => ({ x, z })
const rect = (v: number[]): Rect => ({ x1: v[0], z1: v[1], x2: v[2], z2: v[3] })
export const routeLength = (path: Point[]): number => path.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - path[i].x, p.z - path[i].z), 0)
function makeMap(id: MapId, name: { ru: string; en: string }, width: number, height: number, depotX: number, stationZ: [number, number], routes: [number[][], number[][]], pads: number[][], water: number[], bridge: number[], bridgeWork: number[], walls: number[][], destructible: number[]): MapData {
  const z = height / 2
  const reflect = (p: Point): Point => ({ x: width - p.x, z: p.z })
  const reflectRect = (r: Rect): Rect => ({ x1: width - r.x2, z1: r.z1, x2: width - r.x1, z2: r.z2 })
  const leftRoutes = { N: routes[0].map(([x, zz]) => point(x, zz)), S: routes[1].map(([x, zz]) => point(x, zz)) }
  const map: MapData = {
    id, version: MAP_VERSION, name, width, height,
    bases: { L: point(5, z), R: point(width - 5, z) },
    protected: { L: rect([1, z - 5, 9, z + 5]), R: rect([width - 9, z - 5, width - 1, z + 5]) },
    spawns: { L: [point(4, z - 2), point(4, z), point(4, z + 2)], R: [point(width - 4, z - 2), point(width - 4, z), point(width - 4, z + 2)] },
    depots: { L: point(depotX, z), R: point(width - depotX, z) }, complex: point(width / 2, z),
    stations: stationZ.map((zz, i) => ({ id: `station-${i + 1}`, x: width / 2, z: zz })),
    routes: { L: leftRoutes, R: { N: leftRoutes.N.map(reflect), S: leftRoutes.S.map(reflect) } },
    routeLengths: { N: routeLength(leftRoutes.N), S: routeLength(leftRoutes.S) }, pads: [], water: [rect(water), reflectRect(rect(water))], walls: [],
  }
  for (const side of ['L', 'R'] as Side[]) {
    for (const [i, [x, zz]] of pads.entries()) {
      const p = side === 'L' ? point(x, zz) : reflect(point(x, zz))
      map.pads.push({ id: `${side}-${String(i + 1).padStart(2, '0')}`, side, kind: 'ground', ...p, rect: { x1: p.x - 0.9, z1: p.z - 0.9, x2: p.x + 0.9, z2: p.z + 0.9 } })
    }
    const br = side === 'L' ? rect(bridge) : reflectRect(rect(bridge))
    map.pads.push({ id: `${side}-bridge`, side, kind: 'bridge', x: (br.x1 + br.x2) / 2, z: (br.z1 + br.z2) / 2, rect: br, workPoint: side === 'L' ? point(bridgeWork[0], bridgeWork[1]) : reflect(point(bridgeWork[0], bridgeWork[1])) })
    for (const [i, w] of walls.entries()) map.walls.push({ id: `${side}-W${i + 1}`, ...(side === 'L' ? rect(w) : reflectRect(rect(w))), destructible: false })
    map.walls.push({ id: `${side}-D1`, ...(side === 'L' ? rect(destructible) : reflectRect(rect(destructible))), destructible: true })
  }
  return map
}
export const MAPS: Record<MapId, MapData> = {
  FP01: makeMap('FP01', { ru: 'Литейный двор', en: 'Foundry Yard' }, 64, 40, 10, [8, 32], [
    [[10, 20], [13, 20], [13, 8], [32, 8], [32, 20]], [[10, 20], [17, 20], [17, 32], [32, 32], [32, 20]],
  ], [[7, 11], [7, 29], [10, 14], [10, 26], [10, 35], [17, 4], [18, 11], [20, 18], [21, 24], [21, 28], [24, 35], [27, 4], [27, 12], [27, 17], [27, 24], [27, 28]],
  [20, 13, 24, 16], [20, 13, 24, 16], [19, 14.5], [[19, 21, 19.8, 28], [21, 10, 25, 11], [24, 29.2, 29, 30]], [23, 18, 25.8, 19]),
  FP02: makeMap('FP02', { ru: 'Каналы', en: 'Canals' }, 72, 44, 11, [8, 36], [
    [[11, 22], [14, 22], [14, 8], [36, 8], [36, 22]], [[11, 22], [18, 22], [18, 36], [36, 36], [36, 22]],
  ], [[7, 12], [7, 32], [11, 15], [11, 29], [12, 39], [18, 4], [21, 12], [21, 18], [21, 27], [21, 32], [24, 40], [31, 4], [31, 12], [31, 18], [31, 27], [31, 32]],
  [24, 10, 28, 34], [24, 20, 28, 24], [23, 22], [[19, 13, 19.8, 17], [29, 23, 33, 24], [8, 34, 13, 35]], [20, 24, 23, 25]),
  FP03: makeMap('FP03', { ru: 'Длинный обход', en: 'Long Way Around' }, 68, 48, 11, [5, 39], [
    [[11, 24], [14, 24], [14, 9], [26, 9], [26, 5], [34, 5], [34, 24]], [[11, 24], [20, 24], [20, 39], [34, 39], [34, 24]],
  ], [[7, 14], [7, 34], [11, 17], [11, 31], [12, 43], [18, 5], [18, 12], [18, 19], [17, 28], [17, 35], [26, 43], [30, 10], [29, 16], [29, 21], [29, 28], [28, 34]],
  [22, 15, 26, 33], [22, 22, 26, 26], [21, 24], [[16, 14, 17, 17], [27, 29.2, 28, 32.8], [21, 42, 24, 43], [28, 7, 31, 8]], [27, 17.2, 30, 18]),
}
export function getMap(id: MapId): MapData {
  const map = MAPS[id]
  if (!map) throw new Error('forpost:unknown-map')
  return map
}
