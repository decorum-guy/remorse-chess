import { RULES } from './constants'
import { distance, pointOnRoute, segmentRect } from './geometry'
import { getMap } from './maps'
import { inBase, nextId, resetOperation } from './state'
import { publicEvent, teamEvent } from './visibility'
import type { OperationResult, Team, World } from './types'

export function captureStations(w: World): void {
  for (const s of w.stations) {
    const occupants = w.units.filter(u => u.kind !== 'builder' && u.hp > 0 && u.protectedUntil <= w.tick && !inBase(w, u, u.team) && distance(u, s) <= RULES.stationRadius)
    const a = occupants.some(u => u.team === 'A'), b = occupants.some(u => u.team === 'B')
    if (a && b) continue
    if (!a && !b) { s.capturing = null; s.captureTicks = 0; continue }
    const team: Team = a ? 'A' : 'B'
    if (s.owner === team) { s.capturing = null; s.captureTicks = 0; continue }
    if (s.capturing !== team) { s.capturing = team; s.captureTicks = 0 }
    s.captureTicks++
    if (s.captureTicks >= RULES.captureTicks) { s.owner = team; s.capturing = null; s.captureTicks = 0; publicEvent(w, { type: 'station-captured', targetId: s.id, team, point: { x: s.x, z: s.z } }) }
  }
}
export function moveTransports(w: World): void {
  const map = getMap(w.mapId)
  for (const t of w.transports) {
    t.escorted = w.units.some(u => u.team === t.team && u.kind !== 'builder' && u.hp > 0 && distance(u, t) <= RULES.escortRadius)
    t.speed = t.distance >= t.length ? 0 : t.escorted ? RULES.escortedSpeed : RULES.transportSpeed
    const nextDistance = Math.min(t.length, t.distance + t.speed / 30), next = pointOnRoute(map.routes[t.side][t.route], nextDistance)
    const bad = w.walls.some(r => (!r.destructible || r.hp > 0) && segmentRect(t, next, r, 0.8) !== null) || w.buildings.some(b => b.kind !== 'bridge' && segmentRect(t, next, map.pads.find(p => p.id === b.padId)!.rect, 0.8) !== null)
    if (bad) { t.speed = 0; const key = `transport-blocked:${t.id}`; if (!w.technicalErrors.includes(key)) w.technicalErrors.push(key); continue }
    t.distance = nextDistance; t.x = next.x; t.z = next.z; t.angle = next.angle
  }
}
export function spawnTransports(w: World): void {
  const map = getMap(w.mapId)
  for (const team of Object.values(w.teams)) {
    if (w.transports.some(t => t.team === team.id) || w.tick < team.nextTransportTick || team.charge < RULES.transportCost) continue
    const route = team.manualRoute ?? team.nextRoute, path = map.routes[team.side][route], p = pointOnRoute(path, 0)
    team.charge -= RULES.transportCost; team.manualRoute = null; team.nextRoute = route === 'N' ? 'S' : 'N'
    const t = { id: nextId(w, 'transport'), team: team.id, route, side: team.side, hp: RULES.transportHp, maxHp: RULES.transportHp, distance: 0, length: map.routeLengths[route], x: p.x, z: p.z, angle: p.angle, speed: 0, escorted: false, unloadTicks: 0, lastDamageTick: -10000 }
    w.transports.push(t); publicEvent(w, { type: 'transport-ready', targetId: t.id, team: t.team, point: { x: t.x, z: t.z } })
  }
}
export function unloadTransports(w: World): void {
  const center = getMap(w.mapId).complex
  const presence = { A: false, B: false }
  for (const u of w.units) if (u.kind !== 'builder' && u.hp > 0 && u.protectedUntil <= w.tick && distance(u, center) <= RULES.unloadRadius) presence[u.team] = true
  const delivered: string[] = []
  for (const t of w.transports) {
    if (t.distance < t.length) continue
    if (presence[t.team] && !presence[t.team === 'A' ? 'B' : 'A']) {
      if (t.unloadTicks === 0) teamEvent(w, t.team, { type: 'unload-start', targetId: t.id, team: t.team, point: center })
      t.unloadTicks++
      if (t.unloadTicks >= RULES.unloadTicks) {
        w.teams[t.team].deliveries++; w.teams[t.team].nextTransportTick = w.tick + RULES.transportIntervalTicks; delivered.push(t.id)
        publicEvent(w, { type: 'delivery', targetId: t.id, team: t.team, point: center, value: w.teams[t.team].deliveries })
        for (const p of w.participants.filter(p => p.team === t.team)) if (w.units.some(u => u.ownerId === p.id && u.kind !== 'builder' && distance(u, center) <= RULES.unloadRadius)) p.statistics.deliveries++
      }
    } else {
      if (t.unloadTicks) teamEvent(w, t.team, { type: 'unload-interrupted', targetId: t.id, team: t.team, point: center })
      t.unloadTicks = 0
    }
  }
  w.transports = w.transports.filter(t => !delivered.includes(t.id))
}
export function transportProgress(w: World, team: Team): number {
  const t = w.transports.find(t => t.team === team)
  return !t || t.distance <= 0 ? 0 : t.distance >= t.length ? 10000 : Math.floor(10000 * t.distance / t.length)
}
export function concludeOperation(w: World, winner: Team | null, reason: OperationResult['reason']): void {
  if (!['battle', 'overtime'].includes(w.phase)) return
  const result: OperationResult = { operation: w.operation, winner, reason, deliveries: { A: w.teams.A.deliveries, B: w.teams.B.deliveries }, progress: { A: transportProgress(w, 'A'), B: transportProgress(w, 'B') } }
  w.operations.push(result)
  if (winner) w.teams[winner].wins++
  publicEvent(w, { type: 'operation-result', ...(winner ? { team: winner } : {}), label: reason, value: w.operation })
  if (w.mode !== 'match' || w.teams.A.wins >= 2 || w.teams.B.wins >= 2 || w.operation >= 3 || w.activeTicks >= RULES.matchLimitTicks) {
    w.phase = 'finished'; w.winner = w.teams.A.wins === w.teams.B.wins ? null : w.teams.A.wins > w.teams.B.wins ? 'A' : 'B'; w.resultId = `${w.matchId}:result`; w.phaseStartTick = w.tick
    publicEvent(w, { type: 'match-result', ...(w.winner ? { team: w.winner } : {}) })
  } else { w.phase = 'operationResult'; w.phaseStartTick = w.tick }
}
export function evaluateOperation(w: World): void {
  const a = w.teams.A.deliveries, b = w.teams.B.deliveries, elapsed = w.tick - w.phaseStartTick
  if (w.activeTicks >= RULES.matchLimitTicks) {
    const pa = transportProgress(w, 'A'), pb = transportProgress(w, 'B')
    concludeOperation(w, a !== b ? a > b ? 'A' : 'B' : pa === pb ? null : pa > pb ? 'A' : 'B', 'limit'); return
  }
  if (w.phase === 'battle') {
    if (Math.max(a, b) >= 3 || elapsed >= RULES.battleTicks) {
      if (a !== b) concludeOperation(w, a > b ? 'A' : 'B', 'deliveries')
      else { w.phase = 'overtime'; w.phaseStartTick = w.tick; publicEvent(w, { type: 'overtime' }) }
    }
  } else if (w.phase === 'overtime') {
    if (a !== b) concludeOperation(w, a > b ? 'A' : 'B', 'deliveries')
    else if (elapsed >= RULES.overtimeTicks) {
      const pa = transportProgress(w, 'A'), pb = transportProgress(w, 'B')
      concludeOperation(w, pa === pb ? null : pa > pb ? 'A' : 'B', pa === pb ? 'equal' : 'progress')
    }
  }
}
export function advanceNonCombatPhase(w: World): void {
  if (w.phase === 'preparation' && w.tick - w.phaseStartTick >= RULES.preparationTicks) {
    w.phase = 'battle'; w.phaseStartTick = w.tick
    for (const t of Object.values(w.teams)) t.nextTransportTick = w.tick + RULES.firstTransportTicks
    publicEvent(w, { type: 'battle-start', value: w.operation })
  } else if (w.phase === 'operationResult' && w.tick - w.phaseStartTick >= RULES.resultTicks) {
    w.operation++; resetOperation(w)
    for (const team of ['A', 'B'] as Team[]) teamEvent(w, team, { type: 'preparation', value: w.operation })
  }
}
