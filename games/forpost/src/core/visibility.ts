import { VISION } from './constants'
import { distance, distanceSquared, segmentCircle, segmentRect, segmentSegment } from './geometry'
import { getMap } from './maps'
import type { Building, GameEvent, Point, Rect, Team, Unit, World } from './types'

interface VisibilitySnapshot {
  visible: (team: Team, point: Point, targetId?: string) => boolean
  clear: (from: Point, to: Point, fromId?: string, targetId?: string, ignoreSmoke?: boolean) => boolean
  knownSolids: (team: Team) => VisibilitySolid[]
  knownBarriers: (team: Team) => World['barriers']
  prepareTracers: () => void
}
interface VisibilitySolid { id: string; rect: Rect; building?: Building }
interface VisibilityObserver extends Point {
  id?: string; range: number; range2: number
}
interface IndexedVisibilityObserver extends VisibilityObserver {
  solids: VisibilitySolid[]; smokes: World['smokes']; insideSmokes: World['smokes']
}
interface ObserverGrid {
  minX: number; minZ: number; width: number; height: number
  observers: IndexedVisibilityObserver[]
  heads: Int32Array; next: Int32Array; observerIndices: Int32Array; fullyVisible: Int8Array
}
const observerCellSize = 4
function cellFullyVisible(grid: ObserverGrid, cell: number, x1: number, z1: number): boolean {
  const x2 = x1 + observerCellSize, z2 = z1 + observerCellSize
  observer: for (let node = grid.heads[cell]; node >= 0; node = grid.next[node]) {
    const o = grid.observers[grid.observerIndices[node]]
    const dx = Math.max(Math.abs(x1 - o.x), Math.abs(x2 - o.x)), dz = Math.max(Math.abs(z1 - o.z), Math.abs(z2 - o.z))
    if (dx * dx + dz * dz > o.range2 - 1e-8) continue
    // Every observer-to-cell ray lies inside this box. Reject a box touching any occluder;
    // accepting it therefore proves the whole cell visible without sampling or approximation.
    const minX = Math.min(x1, o.x) - 1e-9, maxX = Math.max(x2, o.x) + 1e-9
    const minZ = Math.min(z1, o.z) - 1e-9, maxZ = Math.max(z2, o.z) + 1e-9
    for (const s of o.smokes) if (s.x - s.radius <= maxX && s.x + s.radius >= minX && s.z - s.radius <= maxZ && s.z + s.radius >= minZ) continue observer
    for (const s of o.solids) if (s.rect.x1 <= maxX && s.rect.x2 >= minX && s.rect.z1 <= maxZ && s.rect.z2 >= minZ) continue observer
    return true
  }
  return false
}
function observerGrid(observers: IndexedVisibilityObserver[]): ObserverGrid {
  // Conservative broad phase only: every candidate still passes the unchanged range/occlusion tests.
  const minX = Math.min(...observers.map(o => Math.floor((o.x - o.range - 1e-9) / observerCellSize)))
  const minZ = Math.min(...observers.map(o => Math.floor((o.z - o.range - 1e-9) / observerCellSize)))
  const maxX = Math.max(...observers.map(o => Math.floor((o.x + o.range + 1e-9) / observerCellSize)))
  const maxZ = Math.max(...observers.map(o => Math.floor((o.z + o.range + 1e-9) / observerCellSize)))
  const width = maxX - minX + 1, height = maxZ - minZ + 1
  const ranges = observers.map(o => ({
    x1: Math.floor((o.x - o.range - 1e-9) / observerCellSize) - minX, x2: Math.floor((o.x + o.range + 1e-9) / observerCellSize) - minX,
    z1: Math.floor((o.z - o.range - 1e-9) / observerCellSize) - minZ, z2: Math.floor((o.z + o.range + 1e-9) / observerCellSize) - minZ,
  }))
  const count = ranges.reduce((sum, r) => sum + (r.x2 - r.x1 + 1) * (r.z2 - r.z1 + 1), 0)
  const heads = new Int32Array(width * height).fill(-1), next = new Int32Array(count), observerIndices = new Int32Array(count)
  let node = 0
  // Reverse insertion keeps the original observer order without allocating one array per cell.
  for (let index = observers.length - 1; index >= 0; index--) {
    const r = ranges[index]
    for (let z = r.z1; z <= r.z2; z++) for (let x = r.x1; x <= r.x2; x++) {
      const cell = z * width + x
      next[node] = heads[cell]; observerIndices[node] = index; heads[cell] = node++
    }
  }
  return { minX, minZ, width, height, observers, heads, next, observerIndices, fullyVisible: new Int8Array(heads.length) }
}
const snapshots = new WeakMap<World, VisibilitySnapshot>()
/** A scoped, derived query cache. Callers must not move entities or change occluders inside the scope. */
export function withVisibilitySnapshot<T>(w: World, read: () => T): T {
  if (snapshots.has(w)) return read()
  const map = getMap(w.mapId), pads = new Map(map.pads.map(p => [p.id, p.rect]))
  const solids: VisibilitySolid[] = w.walls.filter(r => !r.destructible || r.hp > 0).map(rect => ({ id: rect.id, rect }))
  for (const b of w.buildings) if (b.kind !== 'bridge') solids.push({ id: b.id, rect: pads.get(b.padId)!, building: b })
  const observers = { A: [] as VisibilityObserver[], B: [] as VisibilityObserver[] }
  const addObserver = (team: Team, point: Point, range: number, id?: string) => {
    observers[team].push({ x: point.x, z: point.z, id, range, range2: range ** 2 })
  }
  for (const team of ['A', 'B'] as Team[]) addObserver(team, map.bases[w.teams[team].side], VISION.base)
  for (const u of w.units) if (u.hp > 0) addObserver(u.team, u, VISION[u.kind], u.id)
  for (const t of w.transports) addObserver(t.team, t, VISION.transport, t.id)
  for (const b of w.buildings) addObserver(b.team, b, b.powered ? VISION.building : VISION.inactiveBuilding, b.id)
  let grids: Record<Team, ObserverGrid> | undefined
  const prepareTracers = () => {
    if (grids) return
    const index = (team: Team) => observerGrid(observers[team].map(o => {
      const reach = o.range + 1e-9
      const nearSolids = solids.filter(s => s.id !== o.id && s.rect.x1 <= o.x + reach && s.rect.x2 >= o.x - reach && s.rect.z1 <= o.z + reach && s.rect.z2 >= o.z - reach)
      const nearSmokes = w.smokes.filter(s => Math.abs(s.x - o.x) <= reach + s.radius && Math.abs(s.z - o.z) <= reach + s.radius)
      const insideSmokes = nearSmokes.filter(s => { const x = o.x - s.x, z = o.z - s.z; return x * x + z * z - s.radius * s.radius <= 0 })
      return { ...o, solids: nearSolids, smokes: nearSmokes, insideSmokes }
    }))
    grids = { A: index('A'), B: index('B') }
  }
  const clear: VisibilitySnapshot['clear'] = (from, to, fromId, targetId, ignoreSmoke = false) => {
    if (!ignoreSmoke && distanceSquared(from, to) > 2.25) for (const smoke of w.smokes) if (smoke.id !== targetId && segmentCircle(from, to, smoke, smoke.radius) !== null) return false
    for (const solid of solids) if ((!solid.id || (solid.id !== fromId && solid.id !== targetId)) && segmentRect(from, to, solid.rect) !== null) return false
    return true
  }
  const cache = { A: new Map<string, boolean>(), B: new Map<string, boolean>() }
  const visible: VisibilitySnapshot['visible'] = (team, point, targetId) => {
    // Actual entities repeat across target selection, effects and history. Tracer samples do not;
    // avoid allocating coordinate strings for those short-lived points.
    const key = targetId && 'id' in point && point.id === targetId ? targetId : undefined
    const existing = key ? cache[team].get(key) : undefined
    if (existing !== undefined) return existing
    let result = false
    if (!grids) {
      // Short target/nav/view queries do not pay for the tracer acceleration structures.
      for (const observer of observers[team]) if (distanceSquared(observer, point) <= observer.range2 && clear(observer, point, observer.id, targetId)) { result = true; break }
    } else {
      const grid = grids[team], x = Math.floor(point.x / observerCellSize) - grid.minX, z = Math.floor(point.z / observerCellSize) - grid.minZ
      if (x >= 0 && x < grid.width && z >= 0 && z < grid.height) {
        const cell = z * grid.width + x
        if (grid.fullyVisible[cell] === 0) grid.fullyVisible[cell] = cellFullyVisible(grid, cell, (x + grid.minX) * observerCellSize, (z + grid.minZ) * observerCellSize) ? 1 : -1
        if (grid.fullyVisible[cell] === 1) result = true
        else observer: for (let node = grid.heads[cell]; node >= 0; node = grid.next[node]) {
          const o = grid.observers[grid.observerIndices[node]]
          const range2 = distanceSquared(o, point)
          if (range2 > o.range2) continue
          if (range2 > 2.25) {
            for (const smoke of o.insideSmokes) if (smoke.id !== targetId) continue observer
            for (const smoke of o.smokes) if (smoke.id !== targetId && segmentCircle(o, point, smoke, smoke.radius) !== null) continue observer
          }
          for (const solid of o.solids) if (solid.id !== targetId && segmentRect(o, point, solid.rect) !== null) continue observer
          result = true; break
        }
      }
    }
    if (key) cache[team].set(key, result)
    return result
  }
  const solidCache: Partial<Record<Team, VisibilitySolid[]>> = {}, barrierCache: Partial<Record<Team, World['barriers']>> = {}
  const knownSolids = (team: Team) => solidCache[team] ??= solids.filter(s => !s.building || s.building.team === team || visible(team, s.building, s.id))
  const knownBarriers = (team: Team) => barrierCache[team] ??= w.barriers.filter(b => visible(team, b.a) || visible(team, b.b))
  snapshots.set(w, { visible, clear, knownSolids, knownBarriers, prepareTracers })
  try { return read() } finally { snapshots.delete(w) }
}

export function sightClear(w: World, from: Point, to: Point, fromId?: string, targetId?: string, ignoreSmoke = false): boolean {
  const snapshot = snapshots.get(w)
  if (snapshot) return snapshot.clear(from, to, fromId, targetId, ignoreSmoke)
  const map = getMap(w.mapId)
  if (!ignoreSmoke && distanceSquared(from, to) > 2.25 && w.smokes.some(s => s.id !== targetId && segmentCircle(from, to, s, s.radius) !== null)) return false
  if (w.walls.some(r => r.id !== targetId && (!r.destructible || r.hp > 0) && segmentRect(from, to, r) !== null)) return false
  if (w.buildings.some(b => b.kind !== 'bridge' && b.id !== fromId && b.id !== targetId && segmentRect(from, to, map.pads.find(p => p.id === b.padId)!.rect) !== null)) return false
  return true
}
export function isPointVisible(w: World, team: Team, point: Point, targetId?: string): boolean {
  const snapshot = snapshots.get(w)
  if (snapshot) return snapshot.visible(team, point, targetId)
  const map = getMap(w.mapId), base = map.bases[w.teams[team].side]
  if (distanceSquared(base, point) <= VISION.base ** 2 && sightClear(w, base, point, undefined, targetId)) return true
  for (const u of w.units) if (u.team === team && u.hp > 0 && distanceSquared(u, point) <= VISION[u.kind] ** 2 && sightClear(w, u, point, u.id, targetId)) return true
  for (const t of w.transports) if (t.team === team && distanceSquared(t, point) <= VISION.transport ** 2 && sightClear(w, t, point, t.id, targetId)) return true
  for (const b of w.buildings) if (b.team === team && distanceSquared(b, point) <= (b.powered ? VISION.building : VISION.inactiveBuilding) ** 2 && sightClear(w, b, point, b.id, targetId)) return true
  return false
}
export const entityVisible = (w: World, team: Team, entity: Unit | Building): boolean => entity.team === team || isPointVisible(w, team, entity, entity.id)
export function visibleEnemyIds(w: World, team: Team): Set<string> {
  return withVisibilitySnapshot(w, () => new Set([...w.units, ...w.buildings].filter(e => e.team !== team && entityVisible(w, team, e)).map(e => e.id)))
}
export function visibleEnemyBuildingIds(w: World, team: Team): Set<string> {
  return withVisibilitySnapshot(w, () => new Set(w.buildings.filter(e => e.team !== team && entityVisible(w, team, e)).map(e => e.id)))
}
export function updateMemories(w: World): void {
  for (const team of ['A', 'B'] as Team[]) {
    for (const b of w.buildings) if (b.team !== team && entityVisible(w, team, b)) {
      w.memories[team][b.id] = { id: b.id, kind: b.kind, team: b.team, ownerId: b.ownerId, padId: b.padId, x: b.x, z: b.z, hp: b.hp, maxHp: b.maxHp, seenTick: w.tick, stale: true }
    }
    for (const [id, memory] of Object.entries(w.memories[team])) if (!w.buildings.some(b => b.id === id) && isPointVisible(w, team, memory, id)) delete w.memories[team][id]
  }
}
function append(w: World, viewerId: string, event: Omit<GameEvent, 'seq' | 'tick'>): void {
  const list = w.events[viewerId] ?? (w.events[viewerId] = [])
  list.push({ ...event, seq: (w.eventSeq[viewerId] = (w.eventSeq[viewerId] ?? 0) + 1), tick: w.tick })
  // 4 s of ephemeral presentation; durable gameplay comes from the world's state.
  while (list.length && (list[0].tick < w.tick - 120 || list.length > 160)) list.shift()
}
export function publicEvent(w: World, event: Omit<GameEvent, 'seq' | 'tick'>): void { for (const p of w.participants) append(w, p.id, event) }
export function teamEvent(w: World, team: Team, event: Omit<GameEvent, 'seq' | 'tick'>): void { for (const p of w.participants) if (p.team === team) append(w, p.id, event) }
export function ownEvent(w: World, ownerId: string, event: Omit<GameEvent, 'seq' | 'tick'>): void { append(w, ownerId, event) }
export function spatialEvent(w: World, point: Point, type: string, actorId?: string, audibleRadius = 0, publicSource = false): void {
  for (const p of w.participants) {
    if (publicSource || isPointVisible(w, p.team, point, actorId)) append(w, p.id, { type, point: { x: point.x, z: point.z }, ...(actorId ? { actorId } : {}) })
    else if (audibleRadius) {
      const listener = w.units.find(u => u.ownerId === p.id && u.kind === 'fighter')
      if (listener && distance(listener, point) <= audibleRadius) {
        const angle = Math.atan2(point.z - listener.z, point.x - listener.x)
        const sector = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8
        append(w, p.id, { type: `sound:${type}`, sector, proximity: distance(listener, point) <= 8 ? 'near' : 'far', muffled: !sightClear(w, listener, point, listener.id, actorId, true) })
      }
    }
  }
}
export function shotEvent(w: World, source: Point & { id: string }, end: Point, label: string): void {
  const snapshot = snapshots.get(w)
  if (!snapshot) return withVisibilitySnapshot(w, () => shotEvent(w, source, end, label))
  snapshot.prepareTracers()
  for (const team of ['A', 'B'] as Team[]) {
    let fraction = 1
    for (const solid of snapshot.knownSolids(team)) if (!solid.building || solid.id !== source.id) { const t = segmentRect(source, end, solid.rect); if (t !== null) fraction = Math.min(fraction, t) }
    for (const b of snapshot.knownBarriers(team)) { const t = segmentSegment(source, end, b.a, b.b); if (t !== null) fraction = Math.min(fraction, t) }
    const visibleEnd = { x: source.x + (end.x - source.x) * fraction, z: source.z + (end.z - source.z) * fraction }
    const steps = Math.max(1, Math.ceil(distance(source, visibleEnd) / 0.5)), segments: { a: Point; b: Point }[] = []
    let start: Point | null = null, previousX = source.x, previousZ = source.z
    const point = { x: source.x, z: source.z }
    for (let i = 0; i <= steps; i++) {
      point.x = source.x + (visibleEnd.x - source.x) * i / steps; point.z = source.z + (visibleEnd.z - source.z) * i / steps
      const visible = snapshot.visible(team, point, source.id)
      if (visible && !start) start = { x: point.x, z: point.z }
      if (!visible && start) { if (Math.hypot(start.x - previousX, start.z - previousZ) > 0.02) segments.push({ a: start, b: { x: previousX, z: previousZ } }); start = null }
      previousX = point.x; previousZ = point.z
    }
    if (start && distance(start, visibleEnd) > 0.02) segments.push({ a: start, b: visibleEnd })
    for (const p of w.participants) if (p.team === team) {
      for (const s of segments) append(w, p.id, { type: 'shot', point: s.a, end: s.b, label })
      if (snapshot.visible(team, source, source.id)) append(w, p.id, { type: 'muzzle', point: { x: source.x, z: source.z }, actorId: source.id, label })
    }
  }
  spatialEvent(w, source, `weapon:${label}`, source.id, 16)
}
