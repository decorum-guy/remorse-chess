import { DRONE_RADIUS, getArena, getDoors, goalPosition, lineOfSight, poseAtWorld, segmentRect, worldPosition } from '../core';
import type { BotMemory, Pose, RoomId, ShiftCommandPayload, ShiftView, SpaceId, Vec2 } from '../core';
/** Bots receive exactly the same projection as a human of their role. */
function route(board: (RoomId | null)[], from: SpaceId, to: SpaceId, view: ShiftView): SpaceId[] {
  if (from === to) return [from];
  const doors = getDoors(board, view.motion), queue: SpaceId[][] = [[from]], seen = new Set<SpaceId>([from]);
  while (queue.length) {
    const path = queue.shift()!, current = path[path.length - 1];
    for (const d of doors) if (d.spaceId === current && d.open && d.neighbor && !seen.has(d.neighbor)) {
      const next = [...path, d.neighbor]; if (d.neighbor === to) return next;
      seen.add(d.neighbor); queue.push(next);
    }
  }
  return [];
}
export function pilotWaypoint(view: ShiftView, from: Pose, destination: Pose): Vec2 {
  let target: Vec2 = { x: destination.x, z: destination.z };
  if (from.spaceId !== destination.spaceId) {
    const path = route(view.board, from.spaceId, destination.spaceId, view);
    if (path.length < 2) return { x: from.x, z: from.z };
    const door = view.doors.find(d => d.spaceId === from.spaceId && d.open && d.neighbor === path[1])!;
    const origin = worldPosition(view.board, { spaceId: from.spaceId, x: 0, z: 0 }, view.motion, view.tick);
    const vector = door.direction === 'north' ? { x: 0, z: -0.5 } : door.direction === 'south' ? { x: 0, z: 0.5 } : door.direction === 'west' ? { x: -0.5, z: 0 } : { x: 0.5, z: 0 };
    target = { x: door.x - origin.x + vector.x, z: door.z - origin.z + vector.z };
    if (from.spaceId === 'west' || from.spaceId === 'east') {
      if (Math.abs(from.z - target.z) > 0.5) target.x = from.spaceId === 'west' ? 1.15 : -1.15;
      return target;
    }
  }
  if (from.spaceId === 'west' || from.spaceId === 'east') return target;
  const covers = getArena(view.settings.arena).covers[from.spaceId], margin = DRONE_RADIUS + 0.045;
  const obstacles = covers.map(c => ({ minX: c.x - c.width / 2 - margin, maxX: c.x + c.width / 2 + margin, minZ: c.z - c.depth / 2 - margin, maxZ: c.z + c.depth / 2 + margin }));
  // A human or a quantized input can stop inside the planner's extra clearance
  // while remaining physically valid. Step out before asking the route graph;
  // otherwise every graph edge starts inside an obstacle and direct fallback jams.
  const overlap = obstacles.find(r => from.x > r.minX && from.x < r.maxX && from.z > r.minZ && from.z < r.maxZ);
  if (overlap) {
    const escapes = [
      { x: overlap.minX - 0.16, z: from.z }, { x: overlap.maxX + 0.16, z: from.z },
      { x: from.x, z: overlap.minZ - 0.16 }, { x: from.x, z: overlap.maxZ + 0.16 },
    ].filter(p => Math.abs(p.x) < 3.65 && Math.abs(p.z) < 3.65 && obstacles.every(r => !(p.x > r.minX && p.x < r.maxX && p.z > r.minZ && p.z < r.maxZ)));
    escapes.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
    if (escapes[0]) return escapes[0];
  }
  const clear = (a: Vec2, b: Vec2) => obstacles.every(r => segmentRect(a, b, r) === null);
  if (clear(from, target)) return target;
  const nodes: Vec2[] = [{ x: from.x, z: from.z }, target];
  for (const r of obstacles) for (const x of [r.minX - 0.035, r.maxX + 0.035]) for (const z of [r.minZ - 0.035, r.maxZ + 0.035]) {
    if (Math.abs(x) < 3.65 && Math.abs(z) < 3.65 && obstacles.every(o => !(x > o.minX && x < o.maxX && z > o.minZ && z < o.maxZ))) nodes.push({ x, z });
  }
  const distance = nodes.map(() => Infinity), previous = nodes.map(() => -1), visited = new Set<number>(); distance[0] = 0;
  for (let n = 0; n < nodes.length; n++) {
    let i = -1; for (let j = 0; j < nodes.length; j++) if (!visited.has(j) && (i < 0 || distance[j] < distance[i])) i = j;
    if (i < 0 || !Number.isFinite(distance[i])) break;
    if (i === 1) break; visited.add(i);
    for (let j = 0; j < nodes.length; j++) if (!visited.has(j) && clear(nodes[i], nodes[j])) {
      const next = distance[i] + Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
      if (next < distance[j]) { distance[j] = next; previous[j] = i; }
    }
  }
  if (!Number.isFinite(distance[1])) return target;
  const path = [1]; let i = 1; while (previous[i] > 0) { i = previous[i]; path.unshift(i); }
  const first = nodes[path[0]], next = nodes[path[1] ?? 1];
  // A steering controller stops inside its small target tolerance. Extend a reached
  // corner into the next clear segment so that tolerance cannot strand it at a bend.
  if (Math.hypot(first.x - from.x, first.z - from.z) < 0.15 && path.length > 1) {
    const dx = next.x - first.x, dz = next.z - first.z, length = Math.hypot(dx, dz);
    const beyond = { x: first.x + dx / length * 0.18, z: first.z + dz / length * 0.18 };
    if (clear(from, beyond)) return beyond;
  }
  return first;
}
function approximateDistance(view: ShiftView, board: (RoomId | null)[], from: Pose, to: Pose): number {
  const path = route(board, from.spaceId, to.spaceId, { ...view, board, motion: null });
  if (!path.length) return 100;
  const a = worldPosition(board, from), b = worldPosition(board, to);
  return (path.length - 1) * 4 + Math.hypot(a.x - b.x, a.z - b.z);
}
function navigator(view: ShiftView, memory: BotMemory): ShiftCommandPayload[] {
  if (view.tick < memory.nextDecisionTick) return [];
  const difficulty = view.seats.find(s => s.seatId === view.self.seatId)?.difficulty ?? view.settings.difficulty;
  memory.nextDecisionTick = view.tick + (difficulty === 'easy' ? 40 : difficulty === 'hard' ? 10 : 20);
  const allies = view.actors.filter(a => a.team === view.self.team && a.hp > 0), carrier = allies.find(a => a.carrying);
  const battery: Pose = view.battery.spaceId ? { spaceId: view.battery.spaceId, x: view.battery.x ?? 0, z: view.battery.z ?? 0 } : { spaceId: 'O', x: 0, z: 0 };
  const target = carrier ? goalPosition(view.goalSpace) : battery;
  let best: RoomId | null = null, bestScore = 0.6;
  for (const option of view.shiftOptions) if (option.allowed) {
    const board = [...view.board], from = board.indexOf(option.roomId); board[from] = null; board[option.to] = option.roomId;
    const actors = carrier ? [carrier] : allies;
    let score = 0;
    for (const a of actors) score += approximateDistance(view, view.board, a, target) - approximateDistance(view, board, a, target);
    for (const enemy of view.actors.filter(a => a.team !== view.self.team && a.hp > 0)) {
      const enemyGoal = goalPosition(view.goalSpace === 'west' ? 'east' : 'west');
      score += 0.35 * (approximateDistance(view, board, enemy, enemy.carrying ? enemyGoal : battery) - approximateDistance(view, view.board, enemy, enemy.carrying ? enemyGoal : battery));
      // Close a dangerous firing line while transporting our carrier, based only on visible foes.
      if (carrier?.spaceId === option.roomId && enemy.spaceId !== option.roomId && lineOfSight(view.settings.arena, view.board, carrier, enemy, null, view.tick, 12)) score += 3;
    }
    const ping = view.pings.some(p => p.kind === 'shift' && p.roomId === option.roomId);
    if (ping && score >= 0) score += difficulty === 'hard' ? 4 : difficulty === 'easy' ? 1.5 : 3;
    score -= memory.recentRooms.filter(r => r === option.roomId).length * 2;
    if (score > bestScore) { best = option.roomId; bestScore = score; }
  }
  if (!best) return [];
  memory.recentRooms.push(best); memory.recentRooms = memory.recentRooms.slice(-5);
  return [{ type: 'shift', actionId: `bot:${view.self.seatId}:${view.round}:${view.self.controllerEpoch}:${++memory.counter}`, roomId: best, expectedBoardRevision: view.boardRevision, roundId: view.round, controllerEpoch: view.self.controllerEpoch }];
}
export function chooseBotCommands(view: ShiftView, memory: BotMemory): ShiftCommandPayload[] {
  if (view.phase !== 'active' || view.recoveryTicksRemaining > 0) return [];
  if (view.self.role === 'navigator') return navigator(view, memory);
  const actor = view.actors.find(a => a.seatId === view.self.seatId);
  if (!actor || actor.hp <= 0) return [];
  const selfWorld = worldPosition(view.board, actor, view.motion, view.tick);
  let target: Pose;
  const allyCarrier = view.actors.find(a => a.team === view.self.team && a.carrying);
  const enemyCarrier = view.actors.find(a => a.team !== view.self.team && a.carrying);
  if (actor.carrying) target = goalPosition(view.goalSpace);
  else if (view.battery.mode !== 'carried' && view.battery.spaceId) target = { spaceId: view.battery.spaceId, x: view.battery.x ?? 0, z: view.battery.z ?? 0 };
  else if (enemyCarrier) target = { spaceId: enemyCarrier.spaceId, x: enemyCarrier.x, z: enemyCarrier.z };
  else if (allyCarrier) target = { spaceId: allyCarrier.spaceId, x: allyCarrier.x, z: allyCarrier.z + (actor.seatId < allyCarrier.seatId ? -1 : 1) };
  else if (view.ghosts.length) { const ghost = view.ghosts.reduce((a, b) => a.seenAtTick > b.seenAtTick ? a : b); target = poseAtWorld(view.board, { x: ghost.worldX, z: ghost.worldZ }) ?? { spaceId: 'O', x: 0, z: 0 }; }
  else target = { spaceId: 'O', x: 0, z: 0 };
  const point = pilotWaypoint(view, actor, target), dx = point.x - actor.x, dz = point.z - actor.z, length = Math.hypot(dx, dz);
  let moveX = length > 0.08 ? dx / length : 0, moveZ = length > 0.08 ? dz / length : 0;
  // Stop accurately inside the delivery pad and inside interact reach.
  if (actor.carrying && actor.spaceId === target.spaceId && Math.hypot(actor.x - target.x, actor.z - target.z) < 0.3) { moveX = 0; moveZ = 0; }
  if (!actor.carrying && view.battery.mode !== 'carried' && actor.spaceId === target.spaceId && Math.hypot(actor.x - target.x, actor.z - target.z) < 0.6) { moveX = 0; moveZ = 0; }
  const enemies = view.actors.filter(a => a.team !== view.self.team && a.hp > 0 && lineOfSight(view.settings.arena, view.board, actor, a, view.motion, view.tick, 12)).sort((a, b) => {
    const aw = worldPosition(view.board, a, view.motion, view.tick), bw = worldPosition(view.board, b, view.motion, view.tick);
    return Math.hypot(aw.x - selfWorld.x, aw.z - selfWorld.z) - Math.hypot(bw.x - selfWorld.x, bw.z - selfWorld.z);
  });
  const enemy = enemies[0], difficulty = view.seats.find(s => s.seatId === actor.seatId)?.difficulty ?? view.settings.difficulty;
  if (enemy?.seatId !== memory.enemyTargetId) { memory.enemyTargetId = enemy?.seatId; memory.aimUntilTick = view.tick + (difficulty === 'easy' ? 19 : difficulty === 'hard' ? 5 : 11); }
  let aim = actor.aim, fireHeld = false;
  if (enemy) {
    const p = worldPosition(view.board, enemy, view.motion, view.tick), spread = difficulty === 'easy' ? 0.12 : difficulty === 'hard' ? 0.015 : 0.055;
    const salt = actor.seatId.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
    aim = Math.atan2(p.z - selfWorld.z, p.x - selfWorld.x) + Math.sin(view.tick * 0.17 + salt) * spread;
    fireHeld = view.tick >= (memory.aimUntilTick ?? view.tick);
  } else if (length > 0.08) aim = Math.atan2(dz, dx);
  memory.seq = Math.max(memory.seq + 1, view.self.lastAcceptedSeq + 1);
  const scope = { roundId: view.round, controllerEpoch: view.self.controllerEpoch };
  const commands: ShiftCommandPayload[] = [{ type: 'input', seq: memory.seq, moveX, moveZ, aim, fireHeld, ...scope }];
  if (!actor.carrying && view.battery.mode !== 'carried' && view.battery.spaceId && view.battery.x !== undefined && view.battery.z !== undefined && lineOfSight(view.settings.arena, view.board, actor, { spaceId: view.battery.spaceId, x: view.battery.x, z: view.battery.z }, view.motion, view.tick, 0.9)) commands.push({ type: 'interact', actionId: `bot:${view.self.seatId}:${view.round}:${view.self.controllerEpoch}:${++memory.counter}`, ...scope });
  return commands;
}
