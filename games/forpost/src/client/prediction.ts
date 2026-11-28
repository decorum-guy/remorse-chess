import { RULES, TICK_RATE } from '../core/constants'
import { moveSliding, waterObstacles } from '../core/geometry'
import { getMap } from '../core/maps'
import type { Input, Point, WorldView } from '../core/types'

export interface PendingInput { sequence: number; input: Input }
export type PredictedFighter = Point & { id: string; angle: number }
/** Presentation-only movement replay. Receives only the filtered team view. */
export function predictFighter(view: WorldView, pending: PendingInput[]): PredictedFighter | null {
  const me = view.participants.find(p => p.id === view.you)
  const fighter = view.units.find(u => u.ownerId === view.you && u.kind === 'fighter')
  if (!fighter || me?.mode !== 'fighter' || !['battle', 'overtime'].includes(view.phase) || pending.length > 15) return null
  const map = getMap(view.mapId), enemy = view.yourTeam === 'A' ? 'B' : 'A'
  const bridges = view.publicBridges.flatMap(id => { const pad = map.pads.find(p => p.id === id); return pad ? [pad.rect] : [] })
  const obstacles = [
    ...view.walls.filter(wall => !wall.destructible || wall.hp > 0),
    ...waterObstacles(map, bridges), map.protected[view.teams[enemy].side],
    ...[...view.buildings, ...view.memories].filter(b => b.kind !== 'bridge').flatMap(b => { const pad = map.pads.find(p => p.id === b.padId); return pad ? [pad.rect] : [] }),
  ]
  let point: Point = { x: fighter.x, z: fighter.z }, angle = fighter.angle
  for (const { input } of pending) {
    const length = Math.max(1, Math.hypot(input.moveX, input.moveZ))
    point = moveSliding(point, { x: input.moveX / length * RULES.fighterSpeed / TICK_RATE, z: input.moveZ / length * RULES.fighterSpeed / TICK_RATE }, RULES.fighterRadius, map, obstacles)
    if (Math.hypot(input.aimX, input.aimZ) > .001) angle = Math.atan2(input.aimZ, input.aimX)
  }
  return { id: fighter.id, ...point, angle }
}
