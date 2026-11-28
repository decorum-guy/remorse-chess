import { BUILDINGS, RULES } from './constants'
import { buildEligibility } from './actions'
import { getMap } from './maps'
import { entityVisible, isPointVisible, withVisibilitySnapshot } from './visibility'
import type { BuildingKind, BuildingView, GameEvent, ParticipantView, Team, TeamView, UnitView, World, WorldView } from './types'

function eventView(event: GameEvent): GameEvent {
  return { seq: event.seq, tick: event.tick, type: event.type,
    ...(event.point ? { point: { x: event.point.x, z: event.point.z } } : {}), ...(event.end ? { end: { x: event.end.x, z: event.end.z } } : {}),
    ...(event.actorId !== undefined ? { actorId: event.actorId } : {}), ...(event.targetId !== undefined ? { targetId: event.targetId } : {}),
    ...(event.value !== undefined ? { value: event.value } : {}), ...(event.team !== undefined ? { team: event.team } : {}), ...(event.label !== undefined ? { label: event.label } : {}),
    ...(event.sector !== undefined ? { sector: event.sector } : {}), ...(event.proximity !== undefined ? { proximity: event.proximity } : {}), ...(event.muffled !== undefined ? { muffled: event.muffled } : {}),
    ...(event.refund ? { refund: { calculated: event.refund.calculated, credited: event.refund.credited, lost: event.refund.lost } } : {}) }
}

export function phaseRemainingTicks(w: World): number {
  const duration = w.phase === 'preparation' ? RULES.preparationTicks : w.phase === 'battle' ? RULES.battleTicks : w.phase === 'overtime' ? RULES.overtimeTicks : w.phase === 'operationResult' ? RULES.resultTicks : 0
  return Math.max(0, duration - (w.tick - w.phaseStartTick))
}
export function viewForPlayer(w: World, ownerId: string): WorldView {
  return withVisibilitySnapshot(w, () => projectView(w, ownerId))
}
function projectView(w: World, ownerId: string): WorldView {
  const player = w.participants.find(p => p.id === ownerId)
  if (!player) throw new Error('forpost:not-a-participant')
  const team = player.team, finished = w.phase === 'finished', teams = {} as Record<Team, TeamView>
  for (const t of Object.values(w.teams)) {
    teams[t.id] = { id: t.id, side: t.side, deliveries: t.deliveries, wins: t.wins }
    if (t.id === team || finished) Object.assign(teams[t.id], { charge: t.charge, nextTransportTick: t.nextTransportTick, nextRoute: t.nextRoute, manualRoute: t.manualRoute, routeChangedTick: t.routeChangedTick, routeAuthorId: t.routeAuthorId })
  }
  const participants: ParticipantView[] = w.participants.map(p => {
    const v: ParticipantView = { id: p.id, name: p.name, team: p.team, seat: p.seat, controller: p.controller, temporaryBot: p.temporaryBot, botLevel: p.botLevel }
    if (p.team === team || finished) Object.assign(v, { weapon: p.weapon, tool: p.tool, mode: p.mode, credits: p.credits, power: p.power, powerUsed: p.powerUsed, toolReadyTick: p.toolReadyTick, respawnAt: p.respawnAt, respawnBuildingId: p.respawnBuildingId, priority: [...p.priority], builderPaused: p.builderPaused })
    if (p.id === ownerId) { v.lastConsumedInputSeq = p.lastConsumedInputSeq; v.refunds = structuredClone(p.refunds) }
    if (finished) v.statistics = { ...p.statistics }
    return v
  })
  const units: UnitView[] = w.units.filter(u => finished || entityVisible(w, team, u)).map(u => {
    const v: UnitView = { id: u.id, ownerId: u.ownerId, team: u.team, kind: u.kind, generation: u.team === team || finished ? u.generation : 0, x: u.x, z: u.z, hp: u.hp, maxHp: u.maxHp, angle: u.angle, vx: u.vx, vz: u.vz, protected: u.protectedUntil > w.tick }
    if (u.kind === 'fighter') v.weapon = w.participants.find(p => p.id === u.ownerId)!.weapon
    if (u.team === team || finished) { v.magazine = u.magazine; v.reloadUntil = u.reloadUntil; v.order = structuredClone(u.order); v.protectedUntil = u.protectedUntil }
    return v
  })
  const buildings: BuildingView[] = w.buildings.filter(b => finished || entityVisible(w, team, b)).map(b => {
    const v: BuildingView = { id: b.id, ownerId: b.ownerId, team: b.team, kind: b.kind, padId: b.padId, x: b.x, z: b.z, hp: b.hp, maxHp: b.maxHp, angle: b.angle, powered: b.powered, completedTick: b.completedTick === null ? null : b.team === team || finished ? b.completedTick : -1, suppressed: b.kind === 'post' && b.suppressed }
    if (b.team === team || finished) Object.assign(v, { createdTick: b.createdTick, workTicks: b.workTicks, connected: b.connected, disabledReason: b.disabledReason, sellUntil: b.sellUntil, lastDamageTick: b.lastDamageTick, droneQueue: structuredClone(b.droneQueue) })
    return v
  })
  const buildOptions: WorldView['buildOptions'] = {}
  for (const pad of getMap(w.mapId).pads.filter(p => p.side === w.teams[team].side)) buildOptions[pad.id] = (Object.keys(BUILDINGS) as BuildingKind[]).filter(kind => (kind === 'bridge') === (pad.kind === 'bridge')).map(kind => buildEligibility(w, ownerId, pad.id, kind))
  return { rulesVersion: w.rulesVersion, mapVersion: w.mapVersion, matchId: w.matchId, mapId: w.mapId, mode: w.mode, teamSize: w.teamSize, tick: w.tick, phase: w.phase, phaseStartTick: w.phaseStartTick, phaseRemainingTicks: phaseRemainingTicks(w), operation: w.operation, you: ownerId, yourTeam: team,
    teams, participants, units, buildings, memories: Object.values(w.memories[team]).filter(m => !buildings.some(b => b.id === m.id)).map(m => ({ ...m })),
    buildOrders: w.buildOrders.filter(o => w.participants.find(p => p.id === o.ownerId)?.team === team).map(o => ({ ...o })),
    transports: w.transports.map(t => ({ id: t.id, team: t.team, route: t.route, side: t.side, hp: t.hp, maxHp: t.maxHp, distance: t.distance, length: t.length, x: t.x, z: t.z, angle: t.angle, ...(t.team === team || finished ? { speed: t.speed, escorted: t.escorted, unloadTicks: t.unloadTicks } : {}) })),
    // DESIGN §7 explicitly makes ownership AND capture progress public; never include occupants.
    stations: w.stations.map(s => ({ id: s.id, x: s.x, z: s.z, owner: s.owner, capturing: s.capturing, captureTicks: s.captureTicks })),
    walls: w.walls.map(wall => ({ ...wall, hp: wall.hp <= 0 || !wall.destructible || isPointVisible(w, team, { x: (wall.x1 + wall.x2) / 2, z: (wall.z1 + wall.z2) / 2 }, wall.id) ? wall.hp : wall.maxHp })),
    barriers: w.barriers.filter(b => b.team === team || isPointVisible(w, team, b.a) || isPointVisible(w, team, b.b)).map(b => ({ id: b.id, team: b.team, a: { x: b.a.x, z: b.a.z }, b: { x: b.b.x, z: b.b.z }, hp: b.hp, ...(b.team === team || finished ? { ownerId: b.ownerId, expiresTick: b.expiresTick } : {}) })),
    smokes: w.smokes.filter(s => s.team === team || isPointVisible(w, team, s, s.id)).map(s => ({ id: s.id, team: s.team, x: s.x, z: s.z, radius: s.radius, ...(s.team === team || finished ? { ownerId: s.ownerId, expiresTick: s.expiresTick } : {}) })),
    publicBridges: w.buildings.filter(b => b.kind === 'bridge' && b.completedTick !== null).map(b => b.padId),
    operations: structuredClone(w.operations), winner: w.winner, resultId: w.resultId, events: (w.events[ownerId] ?? []).filter(e => e.tick >= w.tick - 120).map(eventView), buildOptions }
}
