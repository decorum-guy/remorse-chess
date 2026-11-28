import { BUILDINGS } from './constants'
import { distance, pointOnRoute } from './geometry'
import { getMap } from './maps'
import { createWorld, fighter, nextId, recomputePower } from './state'
import type { Building, BuildingKind, Point, TutorialProgress, World } from './types'

function addBuilding(w: World, ownerId: string, kind: BuildingKind, padId: string): Building {
  const pad = getMap(w.mapId).pads.find(p => p.id === padId)!, def = BUILDINGS[kind], owner = w.participants.find(p => p.id === ownerId)!
  const b: Building = { id: nextId(w, 'lesson-building'), ownerId, team: owner.team, kind, padId, x: pad.x, z: pad.z, hp: def.hp, maxHp: def.hp, createdTick: w.tick - 2, completedTick: w.tick - 1, workTicks: def.workTicks,
    connected: true, powered: true, disabledReason: null, sellUntil: null, lastDamageTick: -10000, lastAttackerId: null, angle: 0, nextShotExact: 0, targetId: null, targetSinceTick: 0, droneQueue: [], manualAim: null, suppressed: false }
  w.buildings.push(b); return b
}
function addTransport(w: World, distanceAlong: number): void {
  const map = getMap(w.mapId), p = pointOnRoute(map.routes.L.N, distanceAlong)
  w.transports.push({ id: nextId(w, 'lesson-transport'), team: 'A', side: 'L', route: 'N', x: p.x, z: p.z, angle: p.angle, hp: 650, maxHp: 650, distance: distanceAlong, length: map.routeLengths.N, speed: 0, escorted: false, unloadTicks: 0, lastDamageTick: -10000 })
}
/** Seven explicit, isolated teaching fixtures. Their commands and simulation use ordinary rules. */
export function createTutorialWorld(lesson: number, learnerId = 'learner'): World {
  if (!Number.isInteger(lesson) || lesson < 0 || lesson > 6) throw new Error('forpost:unknown-lesson')
  const w = createWorld({ matchId: `tutorial-${learnerId}-${lesson}`, mapId: 'FP01', teamSize: 1, seed: 8128 + lesson, firstSide: 'L', mode: 'tutorial', participants: [
    { id: learnerId, name: 'Курсант', team: 'A', controller: 'human', weapon: 'carbine', tool: 'barrier' },
    { id: 'training-target', name: lesson === 6 ? 'Бот' : 'Учебная мишень', team: 'B', controller: 'bot', botLevel: 'novice' },
  ] })
  w.tick = 600; w.phase = 'battle'; w.phaseStartTick = w.tick; w.activeTicks = 0
  w.teams.A.nextTransportTick = 100000; w.teams.B.nextTransportTick = lesson === 6 ? w.tick + 150 : 100000
  w.tutorial = { lesson, stage: 0, completed: false, learnerId, targetId: null, flags: {}, frozenParticipants: lesson === 6 ? [] : ['training-target'] }
  for (const u of w.units) { u.freshSpawn = false; u.protectedUntil = 0 }
  const u = fighter(w, learnerId)!, target = fighter(w, 'training-target')!
  if (lesson === 0) { u.x = 10; u.z = 18; target.x = 16; target.z = 22; w.tutorial.targetId = target.id }
  if (lesson === 1) { u.x = 17; u.z = 23; u.angle = 0; target.x = 21; target.z = 23; w.tutorial.targetId = target.id }
  if (lesson === 2) { addTransport(w, 37); u.x = 26; u.z = 11; target.x = 32; target.z = 20; w.tutorial.targetId = target.id }
  if (lesson === 3) { u.x = 5; u.z = 20 }
  if (lesson === 4) {
    addBuilding(w, learnerId, 'relay', 'L-03'); addBuilding(w, learnerId, 'turret', 'L-01'); addBuilding(w, learnerId, 'dock', 'L-02'); addBuilding(w, learnerId, 'battery', 'L-07'); addBuilding(w, learnerId, 'extractor', 'L-04')
    w.participants[0].credits = 220; w.tutorial.targetId = w.buildings.find(b => b.kind === 'battery')!.id
  }
  if (lesson === 5) { addBuilding(w, learnerId, 'dock', 'L-03'); addTransport(w, 10); u.x = 10; u.z = 20; w.participants[0].credits = 100 }
  if (lesson === 6) { addTransport(w, 39); u.x = 31; u.z = 14; w.phaseStartTick = w.tick - 270 * 30 }
  recomputePower(w)
  return w
}
export function updateTutorial(w: World): void {
  const t = w.tutorial
  if (!t || w.mode !== 'tutorial' || t.completed) return
  const p = w.participants.find(p => p.id === t.learnerId)!, u = fighter(w, p.id), target = w.units.find(u => u.id === t.targetId)
  if (t.lesson === 0) {
    if (t.stage === 0 && u && distance(u, { x: 12, z: 18 }) < 0.6) t.stage = 1
    else if (t.stage === 1 && u && distance(u, { x: 12, z: 22 }) < 0.6) t.stage = 2
    else if (t.stage === 2 && target && target.hp < target.maxHp) { t.flags.hit = true; t.stage = 3 }
    if (t.stage === 3 && u?.reloadUntil) t.flags.reloading = true
    if (t.stage === 3 && t.flags.reloading && u && !u.reloadUntil && u.magazine === 24) t.completed = true
  } else if (t.lesson === 1) {
    if (t.stage === 0 && (w.events[p.id] ?? []).some(e => e.type === 'blocked' && e.targetId === 'L-W1')) t.stage = 1
    else if (t.stage === 1 && u && distance(u, { x: 20.6, z: 19.8 }) < 0.7) t.stage = 2
    else if (t.stage === 2 && (w.barriers.some(b => b.ownerId === p.id) || w.smokes.some(s => s.ownerId === p.id))) t.completed = true
  } else if (t.lesson === 2) {
    const transport = w.transports.find(tr => tr.team === 'A')
    if (transport?.speed === 0.7) t.flags.slow = true
    if (t.stage === 0 && t.flags.slow && transport?.escorted) { t.stage = 1; t.flags.fast = true }
    if (t.stage === 1 && transport && transport.distance >= transport.length && target && target.hp > 0 && transport.unloadTicks === 0 && u && distance(u, getMap(w.mapId).complex) <= 3) t.stage = 2
    if (t.stage === 2 && (!target || target.hp <= 0)) t.stage = 3
    if (w.teams.A.deliveries > 0 && t.flags.fast) t.completed = true
  } else if (t.lesson === 3) {
    const relay = w.buildings.find(b => b.ownerId === p.id && b.kind === 'relay'), extractor = w.buildings.find(b => b.ownerId === p.id && b.kind === 'extractor')
    if (t.stage === 0 && p.statistics.spent >= 180 && [...w.buildOrders, ...w.buildings].some(o => o.ownerId === p.id && o.kind === 'relay') && [...w.buildOrders, ...w.buildings].some(o => o.ownerId === p.id && o.kind === 'extractor')) t.stage = 1
    if (t.stage === 1 && relay?.completedTick !== null && relay?.powered && extractor?.completedTick !== null && extractor?.powered) { t.stage = 2; t.flags.incomeAt = p.statistics.income; t.flags.incomeTick = w.tick }
    if (t.stage === 2 && w.tick - Number(t.flags.incomeTick) >= 30 && p.statistics.income - Number(t.flags.incomeAt) >= 1.74) t.completed = true
  } else if (t.lesson === 4) {
    const battery = w.buildings.find(b => b.kind === 'battery' && b.ownerId === p.id), extractor = w.buildings.find(b => b.kind === 'extractor' && b.ownerId === p.id)
    if (t.stage === 0 && battery?.powered && p.priority.includes(battery.id)) t.stage = 1
    if (t.stage === 1 && !extractor) t.stage = 2
    if (t.stage >= 1 && w.buildings.some(b => b.ownerId === p.id && b.kind === 'generator' && b.powered) && w.buildings.filter(b => b.ownerId === p.id).every(b => b.powered)) t.completed = true
  } else if (t.lesson === 5) {
    const drone = w.units.find(u => u.ownerId === p.id && u.kind === 'drone'), dock = w.buildings.find(b => b.ownerId === p.id && b.kind === 'dock')
    if (t.stage === 0 && (dock?.droneQueue.length || drone)) t.stage = 1
    if (t.stage === 1 && drone) t.stage = 2
    if (t.stage === 2 && p.mode === 'tactics') t.stage = 3
    if (t.stage === 3 && drone?.order.type === 'escort' && w.transports.some(tr => tr.team === p.team && distance(drone, tr) <= 4)) t.stage = 4
    if (t.stage === 4 && p.mode === 'fighter' && drone?.order.type === 'escort') t.completed = true
  } else if (t.lesson === 6 && w.phase === 'finished') t.completed = true
}
export function tutorialProgress(w: World): TutorialProgress {
  const t = w.tutorial
  if (!t) throw new Error('forpost:not-tutorial')
  const focus: Point[] = []
  if (t.lesson === 0) focus.push(t.stage === 0 ? { x: 12, z: 18 } : t.stage === 1 ? { x: 12, z: 22 } : { x: 16, z: 22 })
  if (t.lesson === 1) focus.push(t.stage === 0 ? { x: 19, z: 23 } : { x: 20.6, z: 19.8 })
  if (t.lesson === 2 || t.lesson === 6) { const tr = w.transports.find(tr => tr.team === 'A'); focus.push(tr ? { x: tr.x, z: tr.z } : { ...getMap(w.mapId).complex }) }
  if (t.lesson === 3) focus.push({ x: 10, z: 14 }, { x: 7, z: 11 })
  if (t.lesson === 4) focus.push(t.stage === 0 ? { x: 18, z: 11 } : { x: 10, z: 26 })
  if (t.lesson === 5) { const drone = w.units.find(u => u.ownerId === t.learnerId && u.kind === 'drone'); focus.push(drone ? { x: drone.x, z: drone.z } : { x: 10, z: 14 }) }
  return { lesson: t.lesson, stage: t.stage, completed: t.completed, key: `lesson.${t.lesson}.${t.stage}`, focus, ...(t.targetId ? { targetId: t.targetId } : {}) }
}
