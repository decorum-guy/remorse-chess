import type { MapData, Point, Rect } from './types'

export const quantize = (value: number): number => Math.round(value * 1000) / 1000
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.z - b.z)
export const distanceSquared = (a: Point, b: Point): number => (a.x - b.x) ** 2 + (a.z - b.z) ** 2
export const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value))
export const angleDelta = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a))
export const rotateToward = (a: number, b: number, max: number): number => a + clamp(angleDelta(a, b), -max, max)
export function normalize(x: number, z: number): Point {
  const length = Math.hypot(x, z)
  return length > 0 ? { x: x / length, z: z / length } : { x: 0, z: 0 }
}
export const insideRect = (p: Point, r: Rect, margin = 0): boolean => p.x >= r.x1 - margin && p.x <= r.x2 + margin && p.z >= r.z1 - margin && p.z <= r.z2 + margin
export const circleIntersectsRect = (p: Point, radius: number, r: Rect): boolean => distanceSquared(p, { x: clamp(p.x, r.x1, r.x2), z: clamp(p.z, r.z1, r.z2) }) <= radius ** 2
export const rectsIntersect = (a: Rect, b: Rect): boolean => a.x1 <= b.x2 && a.x2 >= b.x1 && a.z1 <= b.z2 && a.z2 >= b.z1
export function segmentRect(a: Point, b: Point, r: Rect, padding = 0): number | null {
  if ((a.x < r.x1 - padding && b.x < r.x1 - padding) || (a.x > r.x2 + padding && b.x > r.x2 + padding) || (a.z < r.z1 - padding && b.z < r.z1 - padding) || (a.z > r.z2 + padding && b.z > r.z2 + padding)) return null
  let lo = 0, hi = 1
  const dx = b.x - a.x, dz = b.z - a.z
  if (Math.abs(dx) < 1e-10) { if (a.x < r.x1 - padding || a.x > r.x2 + padding) return null }
  else {
    const t1 = (r.x1 - padding - a.x) / dx, t2 = (r.x2 + padding - a.x) / dx
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2))
    if (lo > hi) return null
  }
  if (Math.abs(dz) < 1e-10) { if (a.z < r.z1 - padding || a.z > r.z2 + padding) return null }
  else {
    const t1 = (r.z1 - padding - a.z) / dz, t2 = (r.z2 + padding - a.z) / dz
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2))
    if (lo > hi) return null
  }
  return lo >= 0 && lo <= 1 ? lo : null
}
export function segmentCircle(a: Point, b: Point, c: Point, radius: number): number | null {
  if ((a.x < c.x - radius && b.x < c.x - radius) || (a.x > c.x + radius && b.x > c.x + radius) || (a.z < c.z - radius && b.z < c.z - radius) || (a.z > c.z + radius && b.z > c.z + radius)) return null
  const dx = b.x - a.x, dz = b.z - a.z, ox = a.x - c.x, oz = a.z - c.z
  const aa = dx * dx + dz * dz, bb = 2 * (ox * dx + oz * dz), cc = ox * ox + oz * oz - radius * radius
  if (cc <= 0) return 0
  if (aa === 0) return null
  const d = bb * bb - 4 * aa * cc
  if (d < 0) return null
  const t = (-bb - Math.sqrt(d)) / (2 * aa)
  return t >= 0 && t <= 1 ? t : null
}
export function segmentSegment(a: Point, b: Point, c: Point, d: Point): number | null {
  const dx = b.x - a.x, dz = b.z - a.z, ex = d.x - c.x, ez = d.z - c.z
  const denom = dx * ez - dz * ex
  if (Math.abs(denom) < 1e-10) return null
  const t = ((c.x - a.x) * ez - (c.z - a.z) * ex) / denom
  const u = ((c.x - a.x) * dz - (c.z - a.z) * dx) / denom
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null
}
export function segmentCapsule(a: Point, b: Point, c: Point, angle: number, radius = 0.8, halfLength = 0.6): number | null {
  const ux = Math.cos(angle), uz = Math.sin(angle)
  const local = (p: Point): Point => ({ x: (p.x - c.x) * ux + (p.z - c.z) * uz, z: -(p.x - c.x) * uz + (p.z - c.z) * ux })
  const aa = local(a), bb = local(b)
  const ts = [segmentRect(aa, bb, { x1: -halfLength, z1: -radius, x2: halfLength, z2: radius }), segmentCircle(aa, bb, { x: -halfLength, z: 0 }, radius), segmentCircle(aa, bb, { x: halfLength, z: 0 }, radius)].filter((v): v is number => v !== null)
  return ts.length ? Math.min(...ts) : null
}
export function subtractRect(source: Rect, cut: Rect): Rect[] {
  if (!rectsIntersect(source, cut)) return [source]
  const out: Rect[] = []
  if (source.x1 < cut.x1) out.push({ ...source, x2: cut.x1 })
  if (source.x2 > cut.x2) out.push({ ...source, x1: cut.x2 })
  const x1 = Math.max(source.x1, cut.x1), x2 = Math.min(source.x2, cut.x2)
  if (source.z1 < cut.z1) out.push({ x1, x2, z1: source.z1, z2: cut.z1 })
  if (source.z2 > cut.z2) out.push({ x1, x2, z1: cut.z2, z2: source.z2 })
  return out
}
export function waterObstacles(map: MapData, bridges: Rect[]): Rect[] {
  let result = map.water.map(r => ({ ...r }))
  for (const bridge of bridges) result = result.flatMap(water => subtractRect(water, bridge))
  return result
}
export function legalPoint(p: Point, radius: number, map: Pick<MapData, 'width' | 'height'>, obstacles: Rect[]): boolean {
  return p.x - radius > 1 && p.z - radius > 1 && p.x + radius < map.width - 1 && p.z + radius < map.height - 1 && !obstacles.some(r => circleIntersectsRect(p, radius, r))
}
export function clearSegment(a: Point, b: Point, radius: number, obstacles: Rect[]): boolean {
  return !obstacles.some(r => segmentRect(a, b, r, radius + 0.002) !== null)
}
export function moveSliding(from: Point, delta: Point, radius: number, map: MapData, obstacles: Rect[]): Point {
  // At 30 Hz the longest legal move is 0.15 m, but substeps also protect tooling/tests.
  const steps = Math.max(1, Math.ceil(Math.hypot(delta.x, delta.z) / 0.12))
  let p = { x: from.x, z: from.z }
  for (let i = 0; i < steps; i++) {
    const next = { x: p.x + delta.x / steps, z: p.z + delta.z / steps }
    if (legalPoint(next, radius, map, obstacles)) p = next
    else {
      const xOnly = { x: next.x, z: p.z }, zOnly = { x: p.x, z: next.z }
      if (legalPoint(xOnly, radius, map, obstacles)) p = xOnly
      if (legalPoint({ x: p.x, z: zOnly.z }, radius, map, obstacles)) p.z = zOnly.z
    }
  }
  return { x: quantize(p.x), z: quantize(p.z) }
}
export function closestLegalPoint(origin: Point, radius: number, map: MapData, obstacles: Rect[], maxDistance: number, extra?: (p: Point) => boolean): Point | null {
  const candidates: Point[] = []
  if (legalPoint(origin, radius, map, obstacles) && (!extra || extra(origin))) return { x: origin.x, z: origin.z }
  // Include exact obstacle projections so nearest-bank choices do not depend on a grid origin.
  for (const r of obstacles) {
    const xs = [r.x1 - radius - 0.003, r.x2 + radius + 0.003, clamp(origin.x, r.x1 - radius - 0.003, r.x2 + radius + 0.003)]
    const zs = [r.z1 - radius - 0.003, r.z2 + radius + 0.003, clamp(origin.z, r.z1 - radius - 0.003, r.z2 + radius + 0.003)]
    for (const x of xs) for (const z of zs) candidates.push({ x, z })
  }
  for (let r = 0.1; r <= maxDistance; r += 0.1) for (let i = 0; i < 64; i++) candidates.push({ x: origin.x + r * Math.cos(i * Math.PI / 32), z: origin.z + r * Math.sin(i * Math.PI / 32) })
  candidates.sort((a, b) => distanceSquared(a, origin) - distanceSquared(b, origin) || a.x - b.x || a.z - b.z)
  const p = candidates.find(p => distance(p, origin) <= maxDistance + 1e-6 && legalPoint(p, radius, map, obstacles) && (!extra || extra(p)))
  return p ? { x: quantize(p.x), z: quantize(p.z) } : null
}
export function pointOnRoute(path: Point[], distanceAlong: number): Point & { angle: number } {
  let remaining = Math.max(0, distanceAlong)
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], length = distance(a, b)
    if (remaining < length || i === path.length - 1) {
      const t = Math.min(1, remaining / length)
      return { x: quantize(a.x + (b.x - a.x) * t), z: quantize(a.z + (b.z - a.z) * t), angle: Math.atan2(b.z - a.z, b.x - a.x) }
    }
    remaining -= length
  }
  return { ...path[path.length - 1], angle: 0 }
}

interface GoalField { distances: Float64Array; next: Int32Array }
interface NavigationGraph { nodes: Point[]; edges: { to: number; distance: number }[][]; goals: Map<string, GoalField> }
// Derived geometry only: this cache is never authoritative or persisted. Its eviction cannot change paths.
const navigationGraphs = new Map<string, NavigationGraph>()
function navigationGraph(radius: number, map: MapData, obstacles: Rect[]): NavigationGraph {
  const key = `${map.width},${map.height}|${radius}|${obstacles.map(r => `${r.x1},${r.z1},${r.x2},${r.z2}`).join(';')}`
  const existing = navigationGraphs.get(key)
  if (existing) return existing
  const margin = radius + 0.012, nodes: Point[] = []
  for (const r of obstacles) for (const p of [{ x: r.x1 - margin, z: r.z1 - margin }, { x: r.x1 - margin, z: r.z2 + margin }, { x: r.x2 + margin, z: r.z1 - margin }, { x: r.x2 + margin, z: r.z2 + margin }]) if (legalPoint(p, radius, map, obstacles)) nodes.push(p)
  const edges: NavigationGraph['edges'] = nodes.map(() => [])
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (clearSegment(nodes[i], nodes[j], radius, obstacles)) {
    const length = distance(nodes[i], nodes[j]); edges[i].push({ to: j, distance: length }); edges[j].push({ to: i, distance: length })
  }
  for (const neighbors of edges) neighbors.sort((a, b) => a.to - b.to)
  const result: NavigationGraph = { nodes, edges, goals: new Map() }
  navigationGraphs.set(key, result)
  if (navigationGraphs.size > 64) navigationGraphs.delete(navigationGraphs.keys().next().value!)
  return result
}
/** Deterministic shortest paths on a visibility graph, sharing a reverse field for a common goal. */
export function findPath(start: Point, goal: Point, radius: number, map: MapData, obstacles: Rect[]): Point[] {
  const target = legalPoint(goal, radius, map, obstacles) ? goal : closestLegalPoint(goal, radius, map, obstacles, 3)
  if (!target) return []
  if (clearSegment(start, target, radius, obstacles)) return [{ x: target.x, z: target.z }]
  const graph = navigationGraph(radius, map, obstacles), key = `${target.x},${target.z}`
  let field = graph.goals.get(key)
  if (!field) {
    const distances = new Float64Array(graph.nodes.length).fill(Infinity), next = new Int32Array(graph.nodes.length).fill(-1), visited = new Uint8Array(graph.nodes.length)
    for (let i = 0; i < graph.nodes.length; i++) if (clearSegment(graph.nodes[i], target, radius, obstacles)) { distances[i] = distance(graph.nodes[i], target); next[i] = -2 }
    for (let count = 0; count < graph.nodes.length; count++) {
      let at = -1, best = Infinity
      for (let i = 0; i < graph.nodes.length; i++) if (!visited[i] && distances[i] < best) { at = i; best = distances[i] }
      if (at < 0) break
      visited[at] = 1
      for (const edge of graph.edges[at]) {
        if (visited[edge.to]) continue
        const candidate = best + edge.distance
        if (candidate < distances[edge.to]) { distances[edge.to] = candidate; next[edge.to] = at }
      }
    }
    field = { distances, next }; graph.goals.set(key, field)
    if (graph.goals.size > 32) graph.goals.delete(graph.goals.keys().next().value!)
  }
  let first = -1, cost = Infinity
  for (let i = 0; i < graph.nodes.length; i++) {
    const candidate = distance(start, graph.nodes[i]) + field.distances[i]
    if (candidate < cost && clearSegment(start, graph.nodes[i], radius, obstacles)) { first = i; cost = candidate }
  }
  if (first < 0) return []
  const result: Point[] = []
  for (let at = first; at >= 0; at = field.next[at]) result.push({ x: graph.nodes[at].x, z: graph.nodes[at].z })
  result.push({ x: target.x, z: target.z })
  return result
}
