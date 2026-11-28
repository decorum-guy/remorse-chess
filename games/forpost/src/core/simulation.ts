import { RULES, WEAPONS } from './constants'
import { planBots } from './bots'
import { fireAutomated, fireFighter } from './combat'
import type { Damage } from './combat'
import { accrueIncome, finishSales, prepareUnits, regenerate, resolveDamage, spawnPendingUnits, workConstruction, workDocks } from './economy'
import { distance, moveSliding } from './geometry'
import { getMap } from './maps'
import { builderMovement, orderPoint, walkToward } from './navigation'
import { advanceNonCombatPhase, captureStations, evaluateOperation, moveTransports, spawnTransports, unloadTransports } from './operations'
import { fighter, inBase, isCombat, lineBlockers, movementObstacles, neutralInput, normalizeInput, participant, recomputePower } from './state'
import { sightClear, spatialEvent, updateMemories, visibleEnemyIds, withVisibilitySnapshot } from './visibility'
import { updateTutorial } from './tutorial'
import type { Input, Unit, World } from './types'

function applyInputs(w: World, inputs: Record<string, Input>): void {
  for (const [id, raw] of Object.entries(inputs)) {
    const p = participant(w, id), input = normalizeInput(raw)
    if (!p || !input || p.controller === 'bot' || p.temporaryBot) continue
    if (raw.inputSeq !== undefined && raw.inputSeq <= p.lastConsumedInputSeq) continue
    p.input = input; p.lastInputTick = w.tick; p.lastConsumedInputSeq = raw.inputSeq ?? p.lastConsumedInputSeq + 1
  }
  for (const p of w.participants) if (w.tick - p.lastInputTick >= RULES.inputExpiryTicks && !(p.controller === 'bot' || p.temporaryBot)) {
    p.input = { ...neutralInput(), aimX: p.input.aimX, aimZ: p.input.aimZ, firePressSeq: p.input.firePressSeq, inputSeq: p.lastConsumedInputSeq }
    p.repair = null
  }
}
function moveUnits(w: World): void {
  const map = getMap(w.mapId)
  // Units do not alter walls, water or buildings while this movement phase runs.
  // Keep this local: damage/construction later in the tick must get fresh geometry.
  const obstacles = { A: movementObstacles(w, 'A'), B: movementObstacles(w, 'B') }
  for (const u of w.units) {
    if (w.tutorial?.frozenParticipants.includes(u.ownerId)) continue
    const p = participant(w, u.ownerId)!
    if (u.kind === 'builder') { builderMovement(w, u, obstacles[u.team]); continue }
    const autonomous = u.kind === 'drone' || p.mode === 'tactics' || p.controller === 'bot' || p.temporaryBot
    if (!autonomous) {
      const delta = { x: p.input.moveX * RULES.fighterSpeed / 30, z: p.input.moveZ * RULES.fighterSpeed / 30 }
      const next = moveSliding(u, delta, u.radius, map, obstacles[u.team])
      u.vx = (next.x - u.x) * 30; u.vz = (next.z - u.z) * 30; u.x = next.x; u.z = next.z
    } else {
      const target = orderPoint(w, u)
      const stop = u.order.type === 'escort' ? 1.5 : u.order.type === 'attack' ? (u.order.lostAt !== undefined ? 0.2 : u.kind === 'drone' ? 10 : WEAPONS[p.weapon].range * 0.75) : u.order.type === 'capture' ? 0.8 : 0.2
      if (target) walkToward(w, u, target, stop, u.kind === 'drone' ? RULES.droneSpeed : RULES.fighterSpeed, obstacles[u.team])
      else { u.vx = 0; u.vz = 0 }
      if (u.order.type === 'move' && target && distance(u, target) <= 0.25) u.order = { type: 'guard', point: { x: target.x, z: target.z } }
    }
  }
}
function repair(w: World): void {
  for (const p of w.participants) {
    if (!p.repair) continue
    const u = fighter(w, p.id), target = [...w.buildings, ...w.transports, ...w.units.filter(u => u.kind === 'drone')].find(e => e.id === p.repair?.targetId && e.team === p.team)
    const automatic = p.controller === 'bot' || p.temporaryBot
    if (!u || !target || w.tick >= p.repair.untilTick || (!p.input.toolHeld && !automatic) || u.lastDamageTick === w.tick || distance(u, target) > RULES.repairRange || !sightClear(w, u, target, u.id, target.id) || inBase(w, u, p.team)) { p.repair = null; continue }
    if (target.hp < target.maxHp) {
      if (!p.repair.started) { p.repair.started = true; p.toolReadyTick = w.tick + RULES.repairCooldownTicks; spatialEvent(w, u, 'tool-repair', u.id, 8) }
      target.hp = Math.min(target.maxHp, target.hp + RULES.repairPerSecond / 30)
    }
  }
}
function recordHistory(w: World): void {
  w.history.push({ tick: w.tick, units: w.units.map(u => ({ id: u.id, generation: u.generation, x: u.x, z: u.z, radius: u.radius, team: u.team, protectedUntil: u.protectedUntil })), visible: { A: [...visibleEnemyIds(w, 'A')], B: [...visibleEnemyIds(w, 'B')] }, blockers: lineBlockers(w), barriers: w.barriers.map(b => ({ a: { ...b.a }, b: { ...b.b } })) })
  while (w.history.length > 6) w.history.shift()
}
/** Advance exactly one authoritative 1/30 s tick. Mutates and returns the same World. */
export function stepWorld(w: World, inputs: Record<string, Input> = {}): World {
  if (w.phase === 'finished') return w
  w.tick++; w.activeTicks++
  applyInputs(w, inputs)
  w.smokes = w.smokes.filter(s => s.expiresTick > w.tick); w.barriers = w.barriers.filter(b => b.expiresTick > w.tick)
  for (const id of Object.keys(w.events)) w.events[id] = w.events[id].filter(e => e.tick >= w.tick - 120)
  // Prior-tick construction and station changes become effective before this tick's weapons/spawns.
  if (isCombat(w)) recomputePower(w)
  planBots(w)
  if (!isCombat(w)) { advanceNonCombatPhase(w); updateMemories(w); updateTutorial(w); return w }
  spawnPendingUnits(w)
  moveUnits(w); moveTransports(w)
  prepareUnits(w)
  const damages: Damage[] = []
  // Damage is collected before resolution, so all shooters share exactly this geometry and vision.
  withVisibilitySnapshot(w, () => {
    for (const u of w.units) {
      if (w.tutorial?.frozenParticipants.includes(u.ownerId)) continue
      const p = participant(w, u.ownerId)!
      if (u.kind === 'fighter') {
        const autonomous = p.mode === 'tactics' || p.controller === 'bot' || p.temporaryBot
        if (p.mode === 'tactics') p.statistics.tacticsTicks++
        fireFighter(w, p, u, damages, autonomous)
      } else if (u.kind === 'drone') fireAutomated(w, u, damages)
    }
    for (const b of w.buildings) fireAutomated(w, b, damages)
  })
  resolveDamage(w, damages)
  regenerate(w); repair(w); finishSales(w)
  recomputePower(w); workConstruction(w); workDocks(w)
  accrueIncome(w); captureStations(w); unloadTransports(w); spawnTransports(w)
  evaluateOperation(w); withVisibilitySnapshot(w, () => { updateMemories(w); recordHistory(w) }); updateTutorial(w)
  return w
}
export function advanceWorld(w: World, count: number, inputs: Record<string, Input> | ((world: World) => Record<string, Input>) = {}): World {
  if (!Number.isSafeInteger(count) || count < 0 || count > 360000) throw new Error('forpost:invalid-tick-count')
  for (let i = 0; i < count && w.phase !== 'finished'; i++) stepWorld(w, typeof inputs === 'function' ? inputs(w) : inputs)
  return w
}
export function unitForPlayer(w: World, ownerId: string): Unit | undefined { return fighter(w, ownerId) }
