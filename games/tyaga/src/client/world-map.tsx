import { useState } from 'react';
import type { TyagaView, Vec3 } from '../core/types';
import { add, conjugate, localPoint, mul, rotate, V } from '../core/math';
import type { Language } from './copy';

function roadPoint(view: TyagaView, x: number, z: number): Vec3 {
  // A marker may target an actual platform as well as a road. This only picks
  // a visible destination; the bot still checks support along its real route.
  const platforms = view.entities.filter(entity => entity.active && ['ferry-deck', 'lift', 'deck', 'ramp'].includes(entity.kind) && entity.state !== 'folded');
  const pads = view.map.surfaces.filter(surface => surface.kind === 'pad');
  let support: Vec3 | null = null;
  const origin = V(x, Math.max(40, view.map.bounds.y) + 10, z);
  for (const surface of [...platforms, ...pads]) {
    if (rotate(surface.rotation, V(0, 1, 0)).y < .7) continue;
    const local = localPoint(surface.position, surface.rotation, origin), direction = rotate(conjugate(surface.rotation), V(0, -1, 0));
    if (Math.abs(direction.y) < .01) continue;
    const amount = (surface.size.y / 2 - local.y) / direction.y;
    if (amount < 0) continue;
    const hit = add(local, mul(direction, amount));
    if (Math.abs(hit.x) > surface.size.x / 2 - .3 || Math.abs(hit.z) > surface.size.z / 2 - .3) continue;
    const world = add(surface.position, rotate(surface.rotation, hit));
    if (!support || world.y > support.y) support = world;
  }
  if (support) return support;
  let nearest = view.map.start, best = Infinity;
  for (const edge of view.map.roadGraph.edges.filter(edge => edge.kind === 'road')) {
    const a = view.map.roadGraph.nodes.find(node => node.id === edge.from)?.position, b = view.map.roadGraph.nodes.find(node => node.id === edge.to)?.position; if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z, denominator = dx * dx + dz * dz;
    const amount = denominator ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / denominator)) : 0;
    const point = { x: a.x + amount * dx, y: a.y + amount * (b.y - a.y), z: a.z + amount * dz }, d = Math.hypot(point.x - x, point.z - z);
    if (d < best) { best = d; nearest = point; }
  }
  if (!Number.isFinite(best)) for (const node of view.map.roadGraph.nodes) { const d = Math.hypot(node.position.x - x, node.position.z - z); if (d < best) { best = d; nearest = node.position; } }
  return { ...nearest };
}
export function WorldMap({ view, mark, onMark, lang }: { view: TyagaView; mark: Vec3 | null; onMark?: (value: Vec3) => void; lang: Language }) {
  const width = view.map.bounds.x, height = view.map.bounds.z;
  const [cursor, setCursor] = useState<Vec3 | null>(null), [focused, setFocused] = useState(false);
  const t = (ru: string, en: string) => lang === 'ru' ? ru : en;
  return <svg viewBox={`0 0 ${width} ${height}`} className="ty-worldmap" role={onMark ? 'group' : 'img'} tabIndex={onMark ? 0 : undefined} aria-label={onMark ? t('Карта экспедиции. Стрелки перемещают указатель, Enter ставит метку на дороге или платформе.', 'Expedition map. Arrow keys move the cursor; Enter places a marker on a road or platform.') : t('Карта экспедиции', 'Expedition map')}
    onFocus={() => { if (onMark) { setFocused(true); setCursor(current => current ?? mark ?? view.entities.find(entity => entity.kind === 'truck')?.position ?? view.map.start); } }} onBlur={() => setFocused(false)}
    onKeyDown={event => { if (!onMark) return; const current = cursor ?? mark ?? view.map.start; if (['Enter', 'Space'].includes(event.code)) { event.preventDefault(); onMark(roadPoint(view, current.x, current.z)); } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) { event.preventDefault(); const step = event.shiftKey ? 5 : 2; setCursor({ x: Math.max(0, Math.min(width, current.x + (event.code === 'ArrowRight' ? step : event.code === 'ArrowLeft' ? -step : 0))), y: current.y, z: Math.max(0, Math.min(height, current.z + (event.code === 'ArrowDown' ? step : event.code === 'ArrowUp' ? -step : 0))) }); } }}
    onClick={event => { if (!onMark) return; const point = event.currentTarget.createSVGPoint(); point.x = event.clientX; point.y = event.clientY; const matrix = event.currentTarget.getScreenCTM(); if (!matrix) return; const local = point.matrixTransform(matrix.inverse()); const value = roadPoint(view, local.x, local.y); setCursor(value); onMark(value); }}>
    <rect width={width} height={height} fill={view.mapId === 'quarry' ? '#b1ced0' : '#d3dfcf'}/>
    {view.map.waterVolumes.map(water => <rect key={water.id} x={water.min.x} y={water.min.z} width={water.max.x - water.min.x} height={water.max.z - water.min.z} fill="#69b2bc"/>)}
    {view.map.routes.map((route, index) => <polyline key={route.id} points={route.points.map(point => `${point.x},${point.z}`).join(' ')} fill="none" stroke={['#f7f0db', '#e1bb7e', '#b2a4c3'][index % 3]} strokeWidth="3" strokeLinejoin="round"/>)}
    {view.entities.filter(entity => entity.active && ['ferry-deck', 'lift'].includes(entity.kind)).map(entity => <polygon key={entity.id} points={[[-1,-1],[1,-1],[1,1],[-1,1]].map(([sx,sz]) => { const p = add(entity.position, rotate(entity.rotation, V(sx * entity.size.x / 2, 0, sz * entity.size.z / 2))); return `${p.x},${p.z}`; }).join(' ')} fill="#719a98" stroke="#345f62" strokeWidth=".5"/>)}
    {[...view.map.checkpoints, view.map.finish].map(zone => <rect key={zone.id} x={zone.position.x - 2.5} y={zone.position.z - 2.5} width="5" height="5" rx="1" fill={zone.id === view.map.finish.id ? '#D97736' : '#397D68'}/>)}
    {view.entities.filter(entity => entity.active && (entity.kind === 'truck' || entity.kind === 'character')).map(entity => <circle key={entity.id} cx={entity.position.x} cy={entity.position.z} r={entity.kind === 'truck' ? 3.2 : 1.8} fill={entity.kind === 'truck' ? '#D97736' : entity.participantId === view.participantId ? '#ffffff' : '#344955'} stroke="#344955" strokeWidth=".5"/>)}
    {mark && <g><circle cx={mark.x} cy={mark.z} r="4" fill="none" stroke="#D97736" strokeWidth="1.5"/><path d={`M${mark.x - 6} ${mark.z}h12M${mark.x} ${mark.z - 6}v12`} stroke="#D97736" strokeWidth="1"/></g>}
    {focused && cursor && <circle cx={cursor.x} cy={cursor.z} r="6" fill="none" stroke="#264c48" strokeWidth="1.2" strokeDasharray="2 1"/>}
  </svg>;
}
