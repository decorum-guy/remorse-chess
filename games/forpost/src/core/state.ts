import { BOT_VERSION, BUILDINGS, MAP_VERSION, RULES, RULES_VERSION, WEAPONS } from './constants'
import { distance, insideRect, waterObstacles } from './geometry'
import { getMap } from './maps'
import { opaqueId } from './ids'
import type { Building, CreateWorldOptions, Input, Participant, Point, Rect, Side, Team, Unit, World } from './types'

export const neutralInput = (): Input => ({ moveX: 0, moveZ: 0, aimX: 1, aimZ: 0, fireHeld: false, firePressSeq: 0, toolHeld: false, assist: false })
export const enemyTeam = (team: Team): Team => team === 'A' ? 'B' : 'A'
export const otherSide = (side: Side): Side => side === 'L' ? 'R' : 'L'
export const participant = (w: World, id: string): Participant | undefined => w.participants.find(p => p.id === id)
export const fighter = (w: World, id: string): Unit | undefined => w.units.find(u => u.ownerId === id && u.kind === 'fighter')
export const builder = (w: World, id: string): Unit | undefined => w.units.find(u => u.ownerId === id && u.kind === 'builder')
export const nextId = (w: World, prefix: string): string => opaqueId(w.idSalt, prefix, w.nextId++)
export const inBase = (w: World, p: Point, team: Team): boolean => insideRect(p, getMap(w.mapId).protected[w.teams[team].side])
export const isCombat = (w: World): boolean => w.phase === 'battle' || w.phase === 'overtime'
export function normalizeInput(raw: unknown): Input | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  for (const key of ['moveX', 'moveZ', 'aimX', 'aimZ', 'firePressSeq']) if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) return null
  if (typeof v.fireHeld !== 'boolean' || !Number.isSafeInteger(v.firePressSeq) || (v.firePressSeq as number) < 0) return null
  if (v.inputSeq !== undefined && (!Number.isSafeInteger(v.inputSeq) || (v.inputSeq as number) < 0)) return null
  if (v.toolHeld !== undefined && typeof v.toolHeld !== 'boolean') return null
  if (v.assist !== undefined && typeof v.assist !== 'boolean') return null
  const mx = v.moveX as number, mz = v.moveZ as number, ax = v.aimX as number, az = v.aimZ as number
  const movementLength = Math.max(1, Math.hypot(mx, mz)), aimLength = Math.hypot(ax, az)
  return { moveX: mx / movementLength, moveZ: mz / movementLength, aimX: aimLength ? ax / aimLength : 1, aimZ: aimLength ? az / aimLength : 0,
    fireHeld: v.fireHeld, firePressSeq: v.firePressSeq as number, toolHeld: v.toolHeld === true, assist: v.assist === true, inputSeq: (v.inputSeq as number | undefined) ?? 0 }
}
export function createUnit(w: World, p: Participant, kind: Unit['kind'], position: Point, generation = 1): Unit {
  const hp = kind === 'fighter' ? RULES.fighterHp : kind === 'builder' ? RULES.builderHp : RULES.droneHp
  return { id: kind === 'drone' ? nextId(w, 'drone') : `${kind}:${p.id}`, ownerId: p.id, team: p.team, kind, generation, x: position.x, z: position.z,
    hp, maxHp: hp, radius: kind === 'fighter' ? RULES.fighterRadius : kind === 'builder' ? RULES.builderRadius : RULES.droneRadius,
    angle: w.teams[p.team].side === 'L' ? 0 : Math.PI, vx: 0, vz: 0, lastDamageTick: -10000, lastAttackerId: null,
    magazine: kind === 'fighter' ? WEAPONS[p.weapon].magazine : 0, reloadUntil: 0, nextShotExact: 0, shotSerial: 0,
    targetId: null, targetSinceTick: 0, protectedUntil: 0, freshSpawn: kind === 'fighter', baseHealTicks: 0,
    order: { type: 'guard', point: { x: position.x, z: position.z } }, explicitOrder: false, path: [], pathTarget: null, pathVersion: 0, pathRetryTick: 0 }
}
export function createWorld(options: CreateWorldOptions): World {
  const { matchId, mapId, teamSize, participants: roster, seed } = options
  getMap(mapId)
  if (!matchId || ![1, 2, 3].includes(teamSize) || !Number.isSafeInteger(seed) || roster.length !== 2 * teamSize || !roster.some(p => p.controller === 'human') || new Set(roster.map(p => p.id)).size !== roster.length) throw new Error('forpost:invalid-roster')
  if ((options.idSalt !== undefined && (typeof options.idSalt !== 'string' || !options.idSalt || options.idSalt.length > 256)) || (options.mode !== undefined && !['match', 'training', 'tutorial'].includes(options.mode)) || (options.firstSide !== undefined && !['L', 'R'].includes(options.firstSide))) throw new Error('forpost:invalid-options')
  for (const team of ['A', 'B'] as Team[]) if (roster.filter(p => p.team === team).length !== teamSize) throw new Error('forpost:unequal-teams')
  for (const p of roster) if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(p.id) || ['__proto__', 'constructor', 'prototype'].includes(p.id) || !p.name || p.name.length > 80 || !['human', 'bot'].includes(p.controller) || (p.weapon && !Object.hasOwn(WEAPONS, p.weapon)) || (p.tool && !['barrier', 'smoke', 'repair'].includes(p.tool)) || (p.botLevel && !['novice', 'normal', 'strong'].includes(p.botLevel))) throw new Error('forpost:invalid-participant')
  const firstSide: Side = options.firstSide ?? ((seed >>> 0) % 2 === 0 ? 'L' : 'R')
  const makeTeam = (id: Team, side: Side) => ({ id, side, charge: RULES.initialCharge, chargeRemainder: 0, deliveries: 0, wins: 0, nextTransportTick: 0, nextRoute: 'N' as const, manualRoute: null, routeChangedTick: -10000, routeAuthorId: null, humanRouteTick: -10000 })
  const w: World = { schemaVersion: 1, rulesVersion: RULES_VERSION, mapVersion: MAP_VERSION, botVersion: BOT_VERSION, matchId, mapId, mode: options.mode ?? 'match', teamSize, seed: seed >>> 0, nextId: 1, idSalt: options.idSalt ?? `forpost-local:${matchId}:${seed}`,
    tick: 0, activeTicks: 0, phase: 'preparation', phaseStartTick: 0, operation: 1, firstSide,
    participants: [], teams: { A: makeTeam('A', firstSide), B: makeTeam('B', otherSide(firstSide)) }, units: [], buildings: [], buildOrders: [], transports: [], stations: [], walls: [], barriers: [], smokes: [],
    operations: [], winner: null, resultId: null, events: {}, eventSeq: {}, memories: { A: {}, B: {} }, receipts: {}, history: [], rewindTicks: {}, navigationVersion: 0, technicalErrors: [] }
  w.participants = roster.map((config, index) => ({ ...config, botLevel: config.botLevel ?? 'normal', weapon: config.weapon ?? 'carbine', tool: config.tool ?? 'barrier', mode: 'fighter',
    seat: roster.slice(0, index).filter(p => p.team === config.team).length + 1, credits: RULES.initialCredits, incomeRemainder: 0, power: RULES.basePower, powerUsed: 0, priority: [],
    toolReadyTick: 0, respawnAt: 0, respawnBuildingId: null, builderRespawnAt: 0, input: neutralInput(), lastInputTick: -10000, lastConsumedInputSeq: -1, consumedFirePressSeq: 0,
    temporaryBot: false, botSinceTick: 0, botRandom: ((seed >>> 0) ^ (0x9e3779b9 * (index + 1))) >>> 0 || 1, nextPlanTick: 0, aimError: 0, aimErrorUntil: 0,
    pendingLoadout: null, repair: null, builderPaused: false, fighterGeneration: 1, builderGeneration: 1, statistics: { damage: 0, kills: 0, spent: 0, income: 0, deliveries: 0, tacticsTicks: 0 }, refunds: [] }))
  for (const p of w.participants) { w.events[p.id] = []; w.eventSeq[p.id] = 0 }
  resetOperation(w)
  return w
}
export function resetOperation(w: World): void {
  const map = getMap(w.mapId), sideA = w.operation % 2 === 1 ? w.firstSide : otherSide(w.firstSide)
  w.phase = 'preparation'; w.phaseStartTick = w.tick; w.teams.A.side = sideA; w.teams.B.side = otherSide(sideA)
  w.units = []; w.buildings = []; w.buildOrders = []; w.transports = []; w.barriers = []; w.smokes = []; w.history = []; w.memories = { A: {}, B: {} }
  w.walls = map.walls.map(wall => ({ ...wall, hp: wall.destructible ? RULES.wallHp : -1, maxHp: wall.destructible ? RULES.wallHp : -1 }))
  w.stations = map.stations.map(station => ({ ...station, owner: null, capturing: null, captureTicks: 0 }))
  for (const team of Object.values(w.teams)) { team.charge = RULES.initialCharge; team.chargeRemainder = 0; team.deliveries = 0; team.nextTransportTick = w.tick + RULES.preparationTicks + RULES.firstTransportTicks; team.nextRoute = 'N'; team.manualRoute = null; team.routeChangedTick = -10000; team.humanRouteTick = -10000; team.routeAuthorId = null }
  for (const p of w.participants) {
    p.credits = RULES.initialCredits; p.incomeRemainder = 0; p.power = RULES.basePower; p.powerUsed = 0; p.priority = []; p.toolReadyTick = w.tick; p.respawnAt = 0; p.respawnBuildingId = null; p.builderRespawnAt = 0; p.pendingLoadout = null; p.repair = null; p.builderPaused = false; p.nextPlanTick = w.tick; p.refunds = []
    p.input = neutralInput(); p.consumedFirePressSeq = 0; p.lastInputTick = -10000
    const spawn = map.spawns[w.teams[p.team].side][p.seat - 1]
    w.units.push(createUnit(w, p, 'fighter', spawn, p.fighterGeneration), createUnit(w, p, 'builder', { x: spawn.x + (w.teams[p.team].side === 'L' ? 1 : -1), z: spawn.z + 0.65 }, p.builderGeneration))
  }
  w.navigationVersion++
}
export function movementObstacles(w: World, team: Team, knownBuildingIds?: Set<string>): Rect[] {
  const map = getMap(w.mapId), bridges = w.buildings.filter(b => b.kind === 'bridge' && b.completedTick !== null).map(b => map.pads.find(p => p.id === b.padId)!.rect)
  return [...w.walls.filter(wall => !wall.destructible || wall.hp > 0), ...waterObstacles(map, bridges), map.protected[w.teams[enemyTeam(team)].side],
    ...w.buildings.filter(b => b.kind !== 'bridge' && (!knownBuildingIds || b.team === team || knownBuildingIds.has(b.id))).map(b => map.pads.find(p => p.id === b.padId)!.rect)]
}
export function lineBlockers(w: World, excludeBuildingId?: string): Rect[] {
  const map = getMap(w.mapId)
  return [...w.walls.filter(wall => !wall.destructible || wall.hp > 0), ...w.buildings.filter(b => b.kind !== 'bridge' && b.id !== excludeBuildingId).map(b => map.pads.find(p => p.id === b.padId)!.rect)]
}
export function networkCovers(w: World, team: Team, point: Point): boolean {
  const map = getMap(w.mapId)
  return distance(map.bases[w.teams[team].side], point) <= RULES.baseNetworkRadius || w.buildings.some(b => b.team === team && b.kind === 'relay' && b.powered && distance(b, point) <= RULES.relayNetworkRadius)
}
export function recomputePower(w: World): void {
  const map = getMap(w.mapId)
  for (const b of w.buildings) { b.connected = false; b.powered = false; b.disabledReason = b.completedTick === null || b.completedTick >= w.tick ? 'construction' : 'network' }
  for (const team of ['A', 'B'] as Team[]) {
    const all = w.buildings.filter(b => b.team === team && b.completedTick !== null && b.completedTick < w.tick)
    const relays = all.filter(b => b.kind === 'relay')
    let changed = true
    while (changed) { changed = false; for (const r of relays) if (!r.powered && networkCovers(w, team, r)) { r.connected = true; r.powered = true; r.disabledReason = null; changed = true } }
    for (const b of all) {
      if (b.kind === 'bridge') { b.connected = true; b.powered = true; b.disabledReason = null }
      else if (networkCovers(w, team, b)) { b.connected = true; b.disabledReason = 'power'; if (b.kind === 'generator' || b.kind === 'relay') { b.powered = true; b.disabledReason = null } }
      if (b.kind === 'post') b.suppressed = w.units.some(u => u.team !== team && u.hp > 0 && distance(u, b) <= 6)
    }
    for (const p of w.participants.filter(p => p.team === team)) {
      const owned = all.filter(b => b.ownerId === p.id)
      p.power = RULES.basePower + w.stations.filter(s => s.owner === team).length + 4 * owned.filter(b => b.kind === 'generator' && b.powered).length
      p.powerUsed = owned.filter(b => b.kind === 'relay' && b.powered).length
      const priority = (b: Building): number => p.priority.includes(b.id) ? p.priority.indexOf(b.id) : 100 + RULES.powerOrder.indexOf(b.kind)
      for (const b of owned.filter(b => b.connected && !['relay', 'generator', 'bridge'].includes(b.kind)).sort((a, b) => priority(a) - priority(b) || a.createdTick - b.createdTick || a.id.localeCompare(b.id))) {
        if (p.powerUsed + BUILDINGS[b.kind].power <= p.power) { b.powered = true; b.disabledReason = null; p.powerUsed += BUILDINGS[b.kind].power }
      }
    }
  }
  // A map lookup here also makes corrupted map IDs fail before state escapes.
  if (!map.id) throw new Error('forpost:invalid-map')
}
export function setController(w: World, id: string, kind: 'human' | 'bot'): void {
  const p = participant(w, id)
  if (!p || (p.controller === 'bot' && kind === 'human')) throw new Error('forpost:invalid-controller')
  p.temporaryBot = p.controller === 'human' && kind === 'bot'; p.botSinceTick = w.tick; p.nextPlanTick = w.tick
  p.input = neutralInput(); p.lastInputTick = -10000; p.repair = null
}
export function resetInputStream(w: World, id: string): void {
  const p = participant(w, id)
  if (!p) throw new Error('forpost:invalid-controller')
  p.input = neutralInput(); p.lastInputTick = -10000; p.lastConsumedInputSeq = -1; p.consumedFirePressSeq = 0; p.repair = null
}
export function setRewindEstimate(w: World, id: string, rttMs: number): void {
  if (!participant(w, id) || !Number.isFinite(rttMs) || rttMs < 0) throw new Error('forpost:invalid-rewind')
  w.rewindTicks[id] = Math.min(4, Math.floor(Math.min(150, rttMs / 2) * 30 / 1000))
}
export function serializeWorld(w: World): string { return JSON.stringify(w) }
export function deserializeWorld(json: string): World {
  const w = JSON.parse(json) as World
  if (w.schemaVersion !== 1 || w.rulesVersion !== RULES_VERSION || w.mapVersion !== MAP_VERSION || w.botVersion !== BOT_VERSION || !Array.isArray(w.participants) || !Number.isSafeInteger(w.tick)) throw new Error('forpost:unsupported-save')
  getMap(w.mapId)
  // Additive local tutorial migration; network rooms retain their exact executable artifact.
  w.idSalt ??= `forpost-local:${w.matchId}:${w.seed}`
  return w
}
