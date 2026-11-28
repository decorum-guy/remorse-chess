import { useId, useMemo } from 'react'
import { RULES } from '../core/constants'
import { getMap } from '../core/maps'
import type { MapId, Point, Team, WorldView } from '../core/types'
import { visibleContours } from './scene'

const COLORS = { A: '#47c9e5', B: '#ffb25b' }
function symbolPoints(team: Team, x: number, z: number, radius: number): string {
  const sides = team === 'A' ? 3 : 6
  return Array.from({ length: sides }, (_, index) => { const angle = index / sides * Math.PI * 2 - Math.PI / 2; return `${x + Math.cos(angle) * radius},${z + Math.sin(angle) * radius}` }).join(' ')
}
function captureArc(x: number, z: number, radius: number, ratio: number): string {
  const amount = Math.max(0, Math.min(.9999, ratio)), a = -Math.PI / 2 + amount * Math.PI * 2
  return `M${x},${z - radius}A${radius},${radius} 0 ${amount > .5 ? 1 : 0} 1 ${x + Math.cos(a) * radius},${z + Math.sin(a) * radius}`
}

/** This overview displays the same permitted view as the battlefield; no hidden-world lookup is available. */
export function MapPreview({ mapId, view, onPoint, className = '' }: { mapId: MapId; view?: WorldView; onPoint?: (point: Point) => void; className?: string }) {
  const map = getMap(mapId), fogId = `forpost-map-${useId().replace(/:/g, '')}`
  const contours = useMemo(() => view ? visibleContours(view, map) : [], [view, map])
  const teamAt = (side: 'L' | 'R'): Team => (view ? view.teams.A.side === side : side === 'L') ? 'A' : 'B'
  const bridges = (view?.publicBridges ?? []).map(id => map.pads.find(pad => pad.id === id)).filter(pad => !!pad)
  const stations = view?.stations ?? map.stations.map(station => ({ ...station, owner: null, capturing: null, captureTicks: 0 }))
  return <svg className={`fp-map-preview ${className}`} viewBox={`0 0 ${map.width} ${map.height}`} role={onPoint ? 'button' : 'img'} tabIndex={onPoint ? 0 : undefined} aria-label={`${map.name.ru} / ${map.name.en}`} onKeyDown={onPoint ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onPoint(map.complex) } } : undefined} onClick={onPoint ? event => { const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return; const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); onPoint({ x: Math.min(map.width, Math.max(0, point.x)), z: Math.min(map.height, Math.max(0, point.y)) }) } : undefined}>
    {view && <defs><mask id={fogId} x="0" y="0" width={map.width} height={map.height} maskUnits="userSpaceOnUse"><rect width={map.width} height={map.height} fill="white" />{contours.map((contour, index) => <polygon key={index} points={contour.map(p => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(' ')} fill="black" />)}</mask></defs>}
    <rect width={map.width} height={map.height} fill="#1b2b33" rx="1" />
    <path d={`M1 1H${map.width - 1}V${map.height - 1}H1Z`} fill={map.id === 'FP03' ? '#a18d6a' : '#64736d'} stroke="#94a69c" strokeWidth=".3" />
    {map.water.map((rect, i) => <rect key={i} x={rect.x1} y={rect.z1} width={rect.x2 - rect.x1} height={rect.z2 - rect.z1} fill="#174a59" stroke="#8faeac" strokeWidth=".35" />)}
    {(['L', 'R'] as const).flatMap(side => (['N', 'S'] as const).map(route => <polyline key={side + route} points={map.routes[side][route].map(p => `${p.x},${p.z}`).join(' ')} fill="none" stroke={COLORS[teamAt(side)]} strokeWidth=".8" opacity=".8" />))}
    {(view?.walls ?? map.walls).filter(wall => !wall.destructible || !('hp' in wall) || Number(wall.hp) > 0).map(wall => <rect key={wall.id} x={wall.x1} y={wall.z1} width={wall.x2 - wall.x1} height={wall.z2 - wall.z1} fill={wall.destructible ? '#baa075' : '#d2d8cd'} />)}
    {map.pads.filter(pad => pad.kind === 'ground').map(pad => <rect key={pad.id} x={pad.x - .7} y={pad.z - .7} width="1.4" height="1.4" fill="#202f34" opacity=".65" />)}
    {bridges.map(pad => <g key={pad.id}><rect x={pad.rect.x1} y={pad.rect.z1} width={pad.rect.x2 - pad.rect.x1} height={pad.rect.z2 - pad.rect.z1} fill="#9baca5" stroke="#d6d3b4" strokeWidth=".25" /><path d={`M${pad.rect.x1} ${pad.z}H${pad.rect.x2}`} stroke="#d6d3b4" strokeWidth=".4" strokeDasharray=".45 .25" /></g>)}
    {view && <rect width={map.width} height={map.height} fill="#17242d" opacity=".5" mask={`url(#${fogId})`} />}
    {stations.map(station => <g key={station.id}><circle cx={station.x} cy={station.z} r="1.6" fill={station.owner ? COLORS[station.owner] : '#ebdca8'} stroke="#243d45" strokeWidth=".45" />{station.capturing && station.captureTicks > 0 && <path d={captureArc(station.x, station.z, 2.2, station.captureTicks / RULES.captureTicks)} fill="none" stroke={COLORS[station.capturing]} strokeWidth=".55" />}</g>)}
    <circle cx={map.complex.x} cy={map.complex.z} r="3" fill="#ebdca8" fillOpacity=".22" stroke="#ebdca8" strokeWidth=".55" />
    {(['L', 'R'] as const).map(side => <polygon key={side} points={symbolPoints(teamAt(side), map.bases[side].x, map.bases[side].z, 1.8)} fill={COLORS[teamAt(side)]} stroke="#162c35" strokeWidth=".35" />)}
    {view?.memories.map(memory => <g key={`memory:${memory.id}`} opacity=".55"><rect x={memory.x - .8} y={memory.z - .8} width="1.6" height="1.6" fill="#9eaaa5" stroke="#c0c7bc" strokeWidth=".25" strokeDasharray=".3 .2" /></g>)}
    {view?.buildings.filter(building => building.kind !== 'bridge').map(building => <g key={building.id}><rect x={building.x - .85} y={building.z - .85} width="1.7" height="1.7" fill={building.powered ? COLORS[building.team] : '#6d8483'} stroke={COLORS[building.team]} strokeWidth=".3" strokeDasharray={building.completedTick === null ? '.3 .2' : undefined} />{building.kind === 'relay' && <circle cx={building.x} cy={building.z} r=".45" fill="none" stroke="#233c43" strokeWidth=".22" />}</g>)}
    {view?.units.map(unit => <g key={unit.id}><polygon points={symbolPoints(unit.team, unit.x, unit.z, unit.kind === 'fighter' ? 1.02 : unit.kind === 'builder' ? .8 : .7)} fill={COLORS[unit.team]} stroke={unit.ownerId === view.you ? '#ffffff' : '#18282d'} strokeWidth={unit.ownerId === view.you ? '.35' : '.22'} />{unit.kind === 'builder' && <path d={`M${unit.x - .3} ${unit.z}h.6M${unit.x} ${unit.z - .3}v.6`} stroke="#18343e" strokeWidth=".2" />}</g>)}
    {view?.transports.map(transport => <g key={transport.id} transform={`translate(${transport.x} ${transport.z}) rotate(${transport.angle * 180 / Math.PI})`}><rect x="-1.3" y="-.75" width="2.6" height="1.5" fill={COLORS[transport.team]} stroke="#fff" strokeWidth=".3" /><path d="M.75-.75V.75" stroke="#223e47" strokeWidth=".35" /></g>)}
  </svg>
}
