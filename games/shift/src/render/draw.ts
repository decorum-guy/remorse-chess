import { getArena, ROOM_IDS } from '../core/arenas';
import { cellOrigin, getDoors, goalPosition, roomOrigin, worldPosition } from '../core/geometry';
import type { ShiftView, VisibleActor } from '../core/types';
import { ARENA_COLORS, TEAM_COLORS } from './types';
import type { Project, ScreenPoint, ShiftRendererProps } from './types';

export function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, cut: number) {
  ctx.beginPath();
  ctx.moveTo(x + cut, y); ctx.lineTo(x + width - cut, y); ctx.lineTo(x + width, y + cut);
  ctx.lineTo(x + width, y + height - cut); ctx.lineTo(x + width - cut, y + height);
  ctx.lineTo(x + cut, y + height); ctx.lineTo(x, y + height - cut); ctx.lineTo(x, y + cut); ctx.closePath();
}

function line(ctx: CanvasRenderingContext2D, a: ScreenPoint, b: ScreenPoint) {
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
}

function ring(ctx: CanvasRenderingContext2D, project: Project, x: number, z: number, radius: number, color: string, dash: number[] = []) {
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash); ctx.beginPath();
  for (let i = 0; i <= 40; i++) { const p = project(x + Math.cos(i * Math.PI / 20) * radius, z + Math.sin(i * Math.PI / 20) * radius, .035); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
  ctx.stroke(); ctx.setLineDash([]);
}

function polygon(ctx: CanvasRenderingContext2D, points: ScreenPoint[], fill?: string) {
  ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.stroke();
}

function plateOutline(ctx: CanvasRenderingContext2D, project: Project, x: number, z: number, size: number, color: string, width = 1.5, fill?: string) {
  const a = size / 2, k = .22;
  ctx.strokeStyle = color; ctx.lineWidth = width;
  polygon(ctx, [[-a + k, -a], [a - k, -a], [a, -a + k], [a, a - k], [a - k, a], [-a + k, a], [-a, a - k], [-a, -a + k]].map(([dx, dz]) => project(x + dx, z + dz, .04)), fill);
}

function batterySymbol(ctx: CanvasRenderingContext2D, point: ScreenPoint, size: number) {
  ctx.save(); ctx.translate(point.x, point.y); ctx.fillStyle = '#ece7da'; ctx.strokeStyle = '#101820'; ctx.lineWidth = 2;
  roundedPath(ctx, -size * .38, -size * .6, size * .76, size * 1.2, 2); ctx.fill(); ctx.stroke();
  ctx.fillRect(-size * .16, -size * .8, size * .32, size * .2);
  ctx.fillStyle = '#6b5935'; ctx.beginPath(); ctx.moveTo(1, -size * .4); ctx.lineTo(-size * .24, size * .04); ctx.lineTo(0, size * .04); ctx.lineTo(-1, size * .37); ctx.lineTo(size * .25, -size * .1); ctx.lineTo(0, -size * .1); ctx.closePath(); ctx.fill(); ctx.restore();
}

export function drawPlan(ctx: CanvasRenderingContext2D, props: ShiftRendererProps, tick: number, project: Project, actors: VisibleActor[]) {
  const view = props.view, theme = ARENA_COLORS[view.settings.arena], arena = getArena(view.settings.arena);
  // The 2D projection and WebGL scene use the same authoritative arena and local spaces.
  for (const side of ['west', 'east'] as const) {
    const o = roomOrigin(view.board, side), a = project(o.x - 2, o.z - 12), b = project(o.x + 2, o.z + 12);
    ctx.fillStyle = '#22333c'; ctx.strokeStyle = '#536d76'; ctx.lineWidth = 1;
    roundedPath(ctx, a.x, a.y, b.x - a.x, b.y - a.y, 5); ctx.fill(); ctx.stroke();
    for (let z = -3; z <= 19; z += 2) {
      const p = project(o.x - .02, z); ctx.fillStyle = '#3c5057'; ctx.fillRect(p.x - 1, p.y, 2, 10);
    }
  }
  const empty = cellOrigin(view.board.indexOf(null));
  plateOutline(ctx, project, empty.x, empty.z, 7.94, '#405760', 1, '#080f16');
  const sa = project(empty.x - 3.7, empty.z - 3.7), sb = project(empty.x + 3.7, empty.z + 3.7);
  ctx.save(); ctx.beginPath(); ctx.rect(sa.x, sa.y, sb.x - sa.x, sb.y - sa.y); ctx.clip(); ctx.strokeStyle = '#304049'; ctx.lineWidth = 1;
  for (let x = sa.x - (sb.y - sa.y); x < sb.x; x += 12) line(ctx, { x, y: sb.y }, { x: x + sb.y - sa.y, y: sa.y });
  ctx.restore();
  for (const room of ROOM_IDS) {
    const o = roomOrigin(view.board, room, view.motion, tick);
    const under = project(o.x - 3.85, o.z - 3.82), underEnd = project(o.x + 3.85, o.z + 4.03);
    ctx.fillStyle = '#0a151a'; roundedPath(ctx, under.x + 2, under.y + 3, underEnd.x - under.x, underEnd.y - under.y, 6); ctx.fill();
    plateOutline(ctx, project, o.x, o.z, 7.78, '#536a73', 1, theme.floor);
    ctx.strokeStyle = '#435860'; ctx.lineWidth = .6;
    for (const v of [-2, 0, 2]) { line(ctx, project(o.x - 3.7, o.z + v), project(o.x + 3.7, o.z + v)); line(ctx, project(o.x + v, o.z - 3.7), project(o.x + v, o.z + 3.7)); }
    for (const c of arena.covers[room]) {
      const a = project(o.x + c.x - c.width / 2, o.z + c.z - c.depth / 2), b = project(o.x + c.x + c.width / 2, o.z + c.z + c.depth / 2);
      ctx.fillStyle = '#0c1a20'; roundedPath(ctx, a.x + 3, a.y + 4, b.x - a.x, b.y - a.y, 3); ctx.fill();
      ctx.fillStyle = theme.cover; ctx.strokeStyle = '#b4c1bb'; ctx.lineWidth = 1;
      roundedPath(ctx, a.x, a.y, b.x - a.x, b.y - a.y, c.kind === 'pillar' ? 4 : 3); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#30444c'; line(ctx, { x: a.x + 4, y: a.y + 3 }, { x: a.x + 4, y: b.y - 3 });
    }
  }
  for (const door of getDoors(view.board, view.motion, tick)) {
    if (door.spaceId === 'west' || door.spaceId === 'east') continue;
    const o = roomOrigin(view.board, door.spaceId, view.motion, tick), horizontal = door.direction === 'north' || door.direction === 'south';
    ctx.lineWidth = 3; ctx.strokeStyle = '#779098';
    if (horizontal) { line(ctx, project(o.x - 3.72, door.z), project(o.x - 1, door.z)); line(ctx, project(o.x + 1, door.z), project(o.x + 3.72, door.z)); }
    else { line(ctx, project(door.x, o.z - 3.72), project(door.x, o.z - 1)); line(ctx, project(door.x, o.z + 1), project(door.x, o.z + 3.72)); }
  }
  const battery = view.battery;
  if (battery.mode !== 'carried' && battery.spaceId && battery.x !== undefined && battery.z !== undefined) {
    const p = worldPosition(view.board, { spaceId: battery.spaceId, x: battery.x, z: battery.z }, view.motion, tick);
    ring(ctx, project, p.x, p.z, .44, '#d8bf7d'); batterySymbol(ctx, project(p.x, p.z), 12);
  }
  for (const actor of actors) {
    const p = worldPosition(view.board, actor, view.motion, tick), q = project(p.x, p.z), unit = Math.max(6, Math.abs(project(p.x + .28, p.z).x - q.x));
    ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(actor.aim); ctx.fillStyle = actor.hp <= 0 ? '#3c4649' : TEAM_COLORS[actor.team]; ctx.strokeStyle = '#d8e5df'; ctx.lineWidth = 1.25;
    if (actor.team === 'teal') { ctx.beginPath(); ctx.ellipse(0, 0, unit, unit * .85, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    else { ctx.beginPath(); ctx.moveTo(unit * 1.1, 0); ctx.lineTo(-unit * .7, unit); ctx.lineTo(-unit * .35, 0); ctx.lineTo(-unit * .7, -unit); ctx.closePath(); ctx.fill(); ctx.stroke(); }
    if (actor.hp > 0) { ctx.fillStyle = '#c8d7ce'; ctx.fillRect(unit * .6, -2, unit * .9, 4); }
    ctx.restore();
    if (actor.carrying) batterySymbol(ctx, { x: q.x - 9, y: q.y - 9 }, 7);
  }
}

export function drawOverlay(ctx: CanvasRenderingContext2D, props: ShiftRendererProps, tick: number, project: Project, actors: VisibleActor[], is2d: boolean, effectTick = tick) {
  const view = props.view, color = TEAM_COLORS[view.self.team], lang = props.lang ?? 'ru';
  ctx.save();
  for (const room of ROOM_IDS) {
    const origin = roomOrigin(view.board, room, view.motion, tick), q = project(origin.x - 3.25, origin.z - 2.9, .02);
    ctx.font = '15px "Russo One", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#d2ddd8';
    ctx.shadowColor = '#101820'; ctx.shadowBlur = 3; ctx.fillText(room === 'O' ? 'O / 08' : room + ' / 0' + (ROOM_IDS.indexOf(room) + 1), q.x, q.y); ctx.shadowBlur = 0;
    const option = view.shiftOptions.find(o => o.roomId === room);
    if (view.self.role === 'navigator' && option?.allowed) plateOutline(ctx, project, origin.x, origin.z, 7.62, color + '77', 1.3);
    if (props.selectedRoomId === room) {
      plateOutline(ctx, project, origin.x, origin.z, 7.57, color, 3);
      if (option?.allowed) {
        const to = cellOrigin(option.to), start = project(origin.x, origin.z, .12), end = project(to.x, to.z, .12);
        ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]); line(ctx, start, end); ctx.setLineDash([]);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        line(ctx, end, { x: end.x - Math.cos(angle - .5) * 13, y: end.y - Math.sin(angle - .5) * 13 });
        line(ctx, end, { x: end.x - Math.cos(angle + .5) * 13, y: end.y - Math.sin(angle + .5) * 13 });
        for (const door of option.doorsAfter.filter(d => d.spaceId === room)) {
          const p = project(door.x, door.z, .12); ctx.fillStyle = door.open ? '#b6fff0' : '#86969b'; ctx.strokeStyle = '#0b151b'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
    }
    if (view.motion?.roomId === room) {
      plateOutline(ctx, project, origin.x, origin.z, 7.94, TEAM_COLORS[view.motion.team], 2.5);
      const m = project(origin.x, origin.z + 3.15, .1); ctx.font = '10px "Onest", sans-serif'; ctx.fillStyle = '#ecf4e9'; ctx.textAlign = 'center';
      ctx.fillText(lang === 'ru' ? 'КОМНАТА ЕДЕТ' : 'ROOM MOVING', m.x, m.y);
      if (props.reducedMotion) {
        const destination = cellOrigin(view.motion.to);
        ctx.setLineDash([4, 5]); plateOutline(ctx, project, destination.x, destination.z, 7.94, TEAM_COLORS[view.motion.team], 2); ctx.setLineDash([]);
      }
    }
  }
  for (const door of getDoors(view.board, view.motion, tick)) {
    if (door.spaceId === 'west' || door.spaceId === 'east') continue;
    const p = project(door.x, door.z, .06), horizontal = door.direction === 'north' || door.direction === 'south';
    ctx.strokeStyle = door.open ? '#8de3cd' : '#e2c38a'; ctx.lineWidth = door.open ? 1.5 : 2.5;
    const a = project(door.x + (horizontal ? -.78 : 0), door.z + (horizontal ? 0 : -.78), .06);
    const b = project(door.x + (horizontal ? .78 : 0), door.z + (horizontal ? 0 : .78), .06);
    if (door.open) { ctx.globalAlpha = .55; ctx.setLineDash([2, 4]); line(ctx, a, b); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    else {
      line(ctx, a, b); ctx.fillStyle = '#101820'; ctx.fillRect(p.x - 3, p.y - 3, 6, 6); ctx.strokeRect(p.x - 2, p.y - 1, 4, 4);
    }
  }
  for (const side of ['west', 'east'] as const) {
    const goal = worldPosition(view.board, goalPosition(side)), own = side === view.goalSpace, team = own ? view.self.team : view.self.team === 'teal' ? 'amber' : 'teal';
    const c = TEAM_COLORS[team];
    ring(ctx, project, goal.x, goal.z, 1.25, c, own ? [] : [4, 4]);
    ctx.strokeStyle = c; ctx.lineWidth = 1;
    polygon(ctx, [[-.8, -.9], [.8, -.9], [.8, .9], [-.8, .9]].map(([x, z]) => project(goal.x + x, goal.z + z, .05)));
    const p = project(goal.x, goal.z + 1.7); ctx.font = '10px "Onest", sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = c;
    ctx.fillText(own ? lang === 'ru' ? 'ВАШИ ВОРОТА' : 'YOUR GATE' : lang === 'ru' ? 'ВОРОТА' : 'GATE', p.x, p.y);
  }
  for (const ghost of view.ghosts) {
    const age = Math.max(0, effectTick - ghost.seenAtTick), p = project(ghost.worldX, ghost.worldZ, .04);
    ctx.globalAlpha = Math.max(0, .55 * (1 - age / 60)); ctx.strokeStyle = TEAM_COLORS[ghost.team]; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(p.x, p.y, 9, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = TEAM_COLORS[ghost.team]; ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.fillText('?', p.x, p.y + 3); ctx.globalAlpha = 1;
  }
  for (const actor of actors) {
    const w = worldPosition(view.board, actor, view.motion, tick), p = project(w.x, w.z, is2d ? 0 : .5), own = actor.seatId === view.self.seatId, ally = actor.team === view.self.team;
    if (actor.hp <= 0) continue;
    if (own) ring(ctx, project, w.x, w.z, .52, '#f4f6dd');
    if (actor.shieldUntilTick > effectTick) ring(ctx, project, w.x, w.z, .65, '#bfe8fa', [4, 3]);
    // Small health bars are visible only because the server included this actor.
    for (let i = 0; i < 3; i++) { ctx.fillStyle = i < actor.hp ? TEAM_COLORS[actor.team] : '#18242b'; ctx.fillRect(p.x - 10 + i * 7, p.y - 15, 5, 3); }
    if (ally && view.self.role === 'navigator') {
      const name = view.seats.find(s => s.seatId === actor.seatId)?.displayName ?? '';
      ctx.font = '10px "Onest", sans-serif'; ctx.fillStyle = '#e1ece6'; ctx.textAlign = 'center'; ctx.fillText(name.length > 13 ? name.slice(0, 12) + '…' : name, p.x, p.y + 17);
    }
    if (actor.chargeTicks > 0) {
      ctx.strokeStyle = '#f7e7b0'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 17, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, actor.chargeTicks / 20)); ctx.stroke();
    }
    if (!is2d && actor.carrying) batterySymbol(ctx, { x: p.x + 9, y: p.y - 8 }, 7);
  }
  const b = view.battery;
  if (b.mode !== 'carried' && b.spaceId && (b.x === undefined || b.z === undefined)) {
    const origin = roomOrigin(view.board, b.spaceId, view.motion, tick), p = project(origin.x, origin.z, .03);
    ctx.globalAlpha = .5; ring(ctx, project, origin.x, origin.z, .72, '#ead7a5', [3, 4]); batterySymbol(ctx, p, 10); ctx.globalAlpha = 1;
  }
  for (const ping of view.pings) {
    if (effectTick >= ping.expiresAtTick) continue;
    const w = worldPosition(view.board, ping, view.motion, tick), p = project(w.x, w.z, .1), pulse = props.reducedMotion || props.effects === false ? 0 : Math.sin(tick * .18) * 2;
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 11 + pulse, 0, Math.PI * 2); ctx.stroke();
    ctx.font = '13px "Russo One", monospace'; ctx.textAlign = 'center'; ctx.fillStyle = color; ctx.fillText(ping.kind === 'shift' ? '↔' : ping.kind === 'battery' ? 'ϟ' : '!', p.x, p.y + 5);
  }
  for (const event of view.events) {
    const age = effectTick - event.tick;
    if (props.reducedMotion && event.kind === 'shift-end' && event.roomId && age >= 0 && age < 6) {
      const target = roomOrigin(view.board, event.roomId, view.motion, tick);
      plateOutline(ctx, project, target.x, target.z, 7.94, '#e3ffef', 3);
    }
    if (event.shot && age >= 0 && age < 5) {
      const a = project(event.shot.from.x, event.shot.from.z, .28), b = project(event.shot.to.x, event.shot.to.z, .28);
      ctx.globalAlpha = Math.max(0, 1 - age / 5); ctx.strokeStyle = event.team ? TEAM_COLORS[event.team] : '#e9eee1'; ctx.lineWidth = 3; line(ctx, a, b); ctx.strokeStyle = '#fff7d7'; ctx.lineWidth = 1; line(ctx, a, b);
      if (event.shot.hit !== 'none' && props.effects !== false) { ctx.fillStyle = '#fff4c1'; ctx.beginPath(); ctx.arc(b.x, b.y, 3 + age * .5, 0, Math.PI * 2); ctx.fill(); } ctx.globalAlpha = 1;
    }
    if (props.effects !== false && event.kind === 'delivered' && age >= 0 && age < 40 && event.team) {
      const side = event.team === view.self.team ? view.goalSpace : view.goalSpace === 'west' ? 'east' : 'west';
      const g = worldPosition(view.board, goalPosition(side)); ctx.globalAlpha = 1 - age / 40;
      ring(ctx, project, g.x, g.z, 1.4 + (props.reducedMotion ? 0 : age / 15), TEAM_COLORS[event.team]); ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

export function interpolatedActors(view: ShiftView, previous: ShiftView | null, alpha: number): VisibleActor[] {
  if (!previous || previous.round !== view.round || alpha >= 1) return view.actors;
  // Iterating the latest view removes bodies immediately when visibility is revoked.
  return view.actors.map(actor => {
    const before = previous.actors.find(a => a.seatId === actor.seatId && a.spaceId === actor.spaceId);
    if (!before || actor.hp <= 0 || before.hp <= 0) return actor;
    return { ...actor, x: before.x + (actor.x - before.x) * alpha, z: before.z + (actor.z - before.z) * alpha };
  });
}
