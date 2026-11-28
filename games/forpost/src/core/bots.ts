import { applyAction } from './actions'
import { BOT_PROFILES, RULES } from './constants'
import { distance } from './geometry'
import { getMap } from './maps'
import { viewForPlayer } from './view'
import type { BuildingKind, Participant, World, WorldView } from './types'

export function randomForBot(p: Participant): number {
  let n = p.botRandom >>> 0
  n ^= n << 13; n ^= n >>> 17; n ^= n << 5
  p.botRandom = n >>> 0 || 1
  return p.botRandom / 0x100000000
}
function chooseBuild(view: WorldView, kind: BuildingKind): string | null {
  const map = getMap(view.mapId), side = view.teams[view.yourTeam].side
  const options = map.pads.filter(p => p.side === side && view.buildOptions[p.id]?.some(o => o.kind === kind && o.ok))
  const owned = view.buildings.filter(b => b.ownerId === view.you)
  options.sort((a, b) => {
    if (kind === 'relay') return (side === 'L' ? b.x - a.x : a.x - b.x) || Math.abs(a.z - map.height / 2) - Math.abs(b.z - map.height / 2) || a.id.localeCompare(b.id)
    const score = (p: typeof a): number => kind === 'extractor' ? distance(p, map.bases[side]) : distance(p, map.complex)
    return score(a) - score(b) || a.id.localeCompare(b.id)
  })
  if (kind === 'relay' && owned.filter(b => b.kind === 'relay').length >= 2) return null
  return options[0]?.id ?? null
}
function build(w: World, p: Participant, view: WorldView, kind: BuildingKind): boolean {
  const padId = chooseBuild(view, kind)
  return padId ? applyAction(w, p.id, { type: 'build', kind, padId }).ok : false
}
/** Policy reads the exact same safe projection as a human. Only own PRNG is private policy state. */
export function planBots(w: World): void {
  if (!['preparation', 'battle', 'overtime'].includes(w.phase)) return
  for (const p of w.participants) {
    if (w.tutorial?.frozenParticipants.includes(p.id)) continue
    if (!(p.controller === 'bot' || p.temporaryBot) || w.tick < Math.ceil(p.nextPlanTick)) continue
    const level = p.temporaryBot ? 'normal' : p.botLevel, profile = BOT_PROFILES[level]
    p.nextPlanTick += profile.planPeriod
    if (p.nextPlanTick < w.tick) p.nextPlanTick = w.tick + profile.planPeriod
    p.mode = 'tactics'
    const view = viewForPlayer(w, p.id), map = getMap(view.mapId)
    const ownUnits = view.units.filter(u => u.ownerId === p.id && u.kind !== 'builder')
    const ownBuildings = view.buildings.filter(b => b.ownerId === p.id)
    const queued = view.buildOrders.filter(o => o.ownerId === p.id)
    const has = (kind: BuildingKind): boolean => ownBuildings.some(b => b.kind === kind) || queued.some(o => o.kind === kind)
    // Team roles use public station state and our own composition, never enemy paths/budgets.
    for (const u of ownUnits) {
      if (w.phase === 'preparation') { applyAction(w, p.id, { type: 'order', unitIds: [u.id], order: { type: 'escort' } }); continue }
      const station = [...view.stations].sort((a, b) => distance(u, a) - distance(u, b)).find(s => s.owner !== p.team)
      const ownTransport = view.transports.find(t => t.team === p.team)
      const enemyTransport = view.transports.find(t => t.team !== p.team)
      let order: Parameters<typeof applyAction>[2] = { type: 'order', unitIds: [u.id], order: { type: 'escort' } }
      if (p.seat === 2 && station && (!ownTransport || distance(u, station) < distance(u, ownTransport) + 8)) order = { type: 'order', unitIds: [u.id], order: { type: 'capture', stationId: station.id } }
      else if (p.seat === 3 && enemyTransport && distance(u, enemyTransport) < 20) order = { type: 'order', unitIds: [u.id], order: { type: 'attack', targetId: enemyTransport.id } }
      else if (!ownTransport && station && distance(u, station) < 12) order = { type: 'order', unitIds: [u.id], order: { type: 'capture', stationId: station.id } }
      if (JSON.stringify(u.order) !== JSON.stringify((order as { order: unknown }).order)) applyAction(w, p.id, order)
    }
    const unit = view.units.find(u => u.ownerId === p.id && u.kind === 'fighter')
    if (unit && p.toolReadyTick <= w.tick && w.phase !== 'preparation') {
      const nearby = view.units.some(e => e.team !== p.team && distance(e, unit) < 9)
      if (p.tool === 'repair') {
        const repairable = [...view.transports, ...view.buildings, ...view.units.filter(u => u.kind === 'drone')].find(e => e.team === p.team && e.hp < e.maxHp && distance(e, unit) <= 3)
        if (repairable) applyAction(w, p.id, { type: 'tool', targetId: repairable.id })
      } else if (nearby && unit.hp < 70) applyAction(w, p.id, { type: 'tool' })
    }
    for (const dock of ownBuildings.filter(b => b.kind === 'dock' && b.completedTick !== null && b.powered)) if ((dock.droneQueue?.length ?? 0) < 2 && p.credits >= 60) applyAction(w, p.id, { type: 'produceDrone', buildingId: dock.id })
    if (queued.length || ownBuildings.length >= RULES.maxBuildings) continue
    if (!has('relay') && p.credits >= 60) { build(w, p, view, 'relay'); continue }
    if (!has('extractor') && w.phase !== 'overtime' && view.phaseRemainingTicks > 90 * 30 && p.credits >= 120) { build(w, p, view, 'extractor'); continue }
    if (!has('dock') && p.credits >= 180) { build(w, p, view, 'dock'); continue }
    if (!has('turret') && p.credits >= 190) { build(w, p, view, 'turret'); continue }
    if (p.credits >= 150 && p.powerUsed >= p.power - 1 && !has('generator')) { build(w, p, view, 'generator'); continue }
    if (!has('post') && p.credits >= 210) { build(w, p, view, 'post'); continue }
    if (level === 'strong' && !has('battery') && p.credits >= 240) build(w, p, view, 'battery')
    const ownTeam = w.teams[p.team]
    if (p.seat === 1 && level !== 'novice' && w.tick - ownTeam.humanRouteTick >= 450 && w.tick - ownTeam.routeChangedTick >= 450 && view.transports.every(t => t.team !== p.team)) {
      const northThreat = view.units.filter(u => u.team !== p.team && u.z < map.height / 2).length
      const southThreat = view.units.filter(u => u.team !== p.team && u.z >= map.height / 2).length
      if (northThreat !== southThreat) applyAction(w, p.id, { type: 'route', route: northThreat < southThreat ? 'N' : 'S' })
    }
  }
}
