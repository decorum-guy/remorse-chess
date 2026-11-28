import { getArena, ROOM_IDS } from './arenas';
import type { ArenaId, Direction, Door, Pose, RoomId, ShiftMotion, SpaceId, Vec2 } from './types';
export const ROOM_SIZE = 8;
export const DRONE_RADIUS = 0.28;
export const DOOR_WIDTH = 2;
export const DIRECTIONS: Direction[] = ['north', 'east', 'south', 'west'];
const DIR: Record<Direction, Vec2> = { north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 } };
export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number }
export function cellOrigin(cell: number): Vec2 { return { x: (cell % 3) * 8, z: Math.floor(cell / 3) * 8 }; }
export function roomOrigin(board: (RoomId | null)[], spaceId: SpaceId, motion: ShiftMotion | null = null, tick = 0): Vec2 {
  if (spaceId === 'west') return { x: -6, z: 8 };
  if (spaceId === 'east') return { x: 22, z: 8 };
  if (motion?.roomId === spaceId) {
    const a = cellOrigin(motion.from), b = cellOrigin(motion.to);
    const t = Math.min(1, Math.max(0, (tick - motion.startTick) / (motion.endTick - motion.startTick)));
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }
  return cellOrigin(board.indexOf(spaceId));
}
export function worldPosition(board: (RoomId | null)[], pose: Pose, motion: ShiftMotion | null = null, tick = 0): Vec2 {
  const origin = roomOrigin(board, pose.spaceId, motion, tick);
  return { x: origin.x + pose.x, z: origin.z + pose.z };
}
export function doorTarget(board: (RoomId | null)[], spaceId: RoomId, direction: Direction, motion: ShiftMotion | null = null): SpaceId | null {
  if (motion?.roomId === spaceId) return null;
  const i = board.indexOf(spaceId), r = Math.floor(i / 3), c = i % 3, d = DIR[direction];
  if (direction === 'west' && c === 0) return 'west';
  if (direction === 'east' && c === 2) return 'east';
  const nr = r + d.z, nc = c + d.x;
  if (nr < 0 || nr > 2 || nc < 0 || nc > 2) return null;
  const other = board[nr * 3 + nc];
  return other && other !== motion?.roomId ? other : null;
}
function lockDoorTarget(board: (RoomId | null)[], side: 'west' | 'east', z: number, motion: ShiftMotion | null): SpaceId | null {
  const row = Math.round((z + 8) / 8), localZ = z - (row * 8 - 8);
  if (row < 0 || row > 2 || Math.abs(localZ) > 1) return null;
  const room = board[row * 3 + (side === 'west' ? 0 : 2)];
  return room && room !== motion?.roomId ? room : null;
}
export function getDoors(board: (RoomId | null)[], motion: ShiftMotion | null = null, tick = 0): Door[] {
  const doors: Door[] = [];
  for (const spaceId of ROOM_IDS) {
    const origin = roomOrigin(board, spaceId, motion, tick);
    for (const direction of DIRECTIONS) {
      const neighbor = doorTarget(board, spaceId, direction, motion), d = DIR[direction];
      doors.push({ spaceId, direction, open: neighbor !== null, neighbor, x: origin.x + d.x * 4, z: origin.z + d.z * 4 });
    }
  }
  for (const side of ['west', 'east'] as const) for (let row = 0; row < 3; row++) {
    const neighbor = lockDoorTarget(board, side, row * 8 - 8, motion);
    doors.push({ spaceId: side, direction: side === 'west' ? 'east' : 'west', open: neighbor !== null, neighbor, x: side === 'west' ? -4 : 20, z: row * 8 });
  }
  return doors;
}
export function coversFree(arenaId: ArenaId, pose: Pose, radius = DRONE_RADIUS): boolean {
  if (pose.spaceId === 'west' || pose.spaceId === 'east') return true;
  return !getArena(arenaId).covers[pose.spaceId].some(c => {
    const dx = Math.max(0, Math.abs(pose.x - c.x) - c.width / 2), dz = Math.max(0, Math.abs(pose.z - c.z) - c.depth / 2);
    return radius === 0 ? Math.abs(pose.x - c.x) < c.width / 2 && Math.abs(pose.z - c.z) < c.depth / 2 : dx * dx + dz * dz < radius * radius;
  });
}
export function pointFree(arenaId: ArenaId, board: (RoomId | null)[], pose: Pose, motion: ShiftMotion | null = null, radius = DRONE_RADIUS): boolean {
  const { spaceId, x, z } = pose;
  if (!Number.isFinite(x) || !Number.isFinite(z) || !coversFree(arenaId, pose, radius)) return false;
  if (spaceId === 'west' || spaceId === 'east') {
    if (Math.abs(z) > 12 - radius || x < -2 || x > 2) return false;
    const inner = spaceId === 'west' ? x > 2 - radius : x < -2 + radius;
    const outer = spaceId === 'west' ? x < -2 + radius : x > 2 - radius;
    if (outer) return false;
    if (inner) {
      const row = Math.round((z + 8) / 8);
      return Math.abs(z - (row * 8 - 8)) <= 1 - radius && lockDoorTarget(board, spaceId, z, motion) !== null;
    }
    return true;
  }
  if (Math.abs(x) > 4 || Math.abs(z) > 4) return false;
  if (x < -4 + radius && !(Math.abs(z) <= 1 - radius && doorTarget(board, spaceId, 'west', motion))) return false;
  if (x > 4 - radius && !(Math.abs(z) <= 1 - radius && doorTarget(board, spaceId, 'east', motion))) return false;
  if (z < -4 + radius && !(Math.abs(x) <= 1 - radius && doorTarget(board, spaceId, 'north', motion))) return false;
  if (z > 4 - radius && !(Math.abs(x) <= 1 - radius && doorTarget(board, spaceId, 'south', motion))) return false;
  return true;
}
/** Coordinates exactly on a threshold remain owned by the previously confirmed space. */
function crossThreshold(board: (RoomId | null)[], pose: Pose, motion: ShiftMotion | null): Pose | null {
  const { spaceId, x, z } = pose;
  if (spaceId === 'west' || spaceId === 'east') {
    const crossed = spaceId === 'west' ? x > 2 : x < -2;
    if (!crossed) return pose;
    const next = lockDoorTarget(board, spaceId, z, motion);
    if (!next || Math.abs(z - (Math.round((z + 8) / 8) * 8 - 8)) > 1 - DRONE_RADIUS) return null;
    const world = worldPosition(board, pose), origin = roomOrigin(board, next);
    return { spaceId: next, x: world.x - origin.x, z: world.z - origin.z };
  }
  const direction: Direction | null = x < -4 ? 'west' : x > 4 ? 'east' : z < -4 ? 'north' : z > 4 ? 'south' : null;
  if (!direction) return pose;
  const next = doorTarget(board, spaceId, direction, motion);
  if (!next || ((direction === 'west' || direction === 'east') ? Math.abs(z) : Math.abs(x)) > 1 - DRONE_RADIUS) return null;
  const world = worldPosition(board, pose), origin = roomOrigin(board, next);
  return { spaceId: next, x: world.x - origin.x, z: world.z - origin.z };
}
export function movePose(arenaId: ArenaId, board: (RoomId | null)[], start: Pose, dx: number, dz: number, motion: ShiftMotion | null = null): Pose {
  let pose: Pose = { spaceId: start.spaceId, x: start.x, z: start.z };
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dz)) / 0.1));
  for (let n = 0; n < steps; n++) for (const axis of ['x', 'z'] as const) {
    const candidate = crossThreshold(board, { ...pose, [axis]: pose[axis] + (axis === 'x' ? dx : dz) / steps }, motion);
    if (candidate && pointFree(arenaId, board, candidate, motion)) pose = candidate;
  }
  return pose;
}
export function correctPose(arenaId: ArenaId, board: (RoomId | null)[], start: Pose, motion: ShiftMotion | null): Pose {
  if (pointFree(arenaId, board, start, motion)) return { spaceId: start.spaceId, x: start.x, z: start.z };
  // Door buffers are empty by arena contract. Closing requires at most one radius of correction.
  const lock = start.spaceId === 'west' || start.spaceId === 'east';
  const safe = { spaceId: start.spaceId, x: Math.max(-(lock ? 2 : 4) + DRONE_RADIUS, Math.min((lock ? 2 : 4) - DRONE_RADIUS, start.x)), z: Math.max(-(lock ? 12 : 4) + DRONE_RADIUS, Math.min((lock ? 12 : 4) - DRONE_RADIUS, start.z)) };
  if (pointFree(arenaId, board, safe, motion)) return safe;
  for (let ring = 1; ring <= 12; ring++) for (let angle = 0; angle < 16; angle++) {
    const p = { spaceId: start.spaceId, x: safe.x + Math.cos(angle * Math.PI / 8) * ring * 0.1, z: safe.z + Math.sin(angle * Math.PI / 8) * ring * 0.1 };
    if (pointFree(arenaId, board, p, motion)) return p;
  }
  return safe;
}
export function rayObstacles(arenaId: ArenaId, board: (RoomId | null)[], motion: ShiftMotion | null = null, tick = 0): Rect[] {
  const out: Rect[] = [], half = 0.035;
  const segment = (x1: number, z1: number, x2: number, z2: number) => out.push({ minX: Math.min(x1, x2) - half, maxX: Math.max(x1, x2) + half, minZ: Math.min(z1, z2) - half, maxZ: Math.max(z1, z2) + half });
  for (const room of ROOM_IDS) {
    const o = roomOrigin(board, room, motion, tick);
    for (const c of getArena(arenaId).covers[room]) out.push({ minX: o.x + c.x - c.width / 2, maxX: o.x + c.x + c.width / 2, minZ: o.z + c.z - c.depth / 2, maxZ: o.z + c.z + c.depth / 2 });
    for (const dir of DIRECTIONS) {
      const d = DIR[dir], vertical = d.x !== 0, open = doorTarget(board, room, dir, motion) !== null;
      const intervals = open ? [[-4, -1], [1, 4]] : [[-4, 4]];
      for (const [a, b] of intervals) {
        if (vertical) segment(o.x + d.x * 4, o.z + a, o.x + d.x * 4, o.z + b);
        else segment(o.x + a, o.z + d.z * 4, o.x + b, o.z + d.z * 4);
      }
    }
  }
  segment(-8, -4, -8, 20); segment(24, -4, 24, 20);
  segment(-8, -4, -4, -4); segment(-8, 20, -4, 20); segment(20, -4, 24, -4); segment(20, 20, 24, 20);
  for (const side of ['west', 'east'] as const) {
    const x = side === 'west' ? -4 : 20;
    for (let row = 0; row < 3; row++) {
      const z = row * 8, open = lockDoorTarget(board, side, z - 8, motion) !== null;
      if (open) { segment(x, z - 4, x, z - 1); segment(x, z + 1, x, z + 4); }
      else segment(x, z - 4, x, z + 4);
    }
  }
  return out;
}
/** Exact segment/AABB intersection, returning distance fraction in [0,1]. */
export function segmentRect(a: Vec2, b: Vec2, r: Rect): number | null {
  let lo = 0, hi = 1;
  for (const axis of ['x', 'z'] as const) {
    const delta = b[axis] - a[axis], min = axis === 'x' ? r.minX : r.minZ, max = axis === 'x' ? r.maxX : r.maxZ;
    if (Math.abs(delta) < 1e-10) { if (a[axis] < min || a[axis] > max) return null; }
    else { const t1 = (min - a[axis]) / delta, t2 = (max - a[axis]) / delta; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); if (lo > hi) return null; }
  }
  return lo;
}
export function wallFraction(a: Vec2, b: Vec2, obstacles: Rect[]): number { let nearest = 1; for (const r of obstacles) { const t = segmentRect(a, b, r); if (t !== null && t < nearest) nearest = t; } return nearest; }
export function lineOfSight(arenaId: ArenaId, board: (RoomId | null)[], from: Pose, to: Pose, motion: ShiftMotion | null = null, tick = 0, limit = Infinity, obstacles?: Rect[]): boolean {
  if (from.spaceId !== to.spaceId && (from.spaceId === motion?.roomId || to.spaceId === motion?.roomId)) return false;
  const a = worldPosition(board, from, motion, tick), b = worldPosition(board, to, motion, tick);
  return Math.hypot(b.x - a.x, b.z - a.z) <= limit && wallFraction(a, b, obstacles ?? rayObstacles(arenaId, board, motion, tick)) >= 0.999999;
}
export function goalPosition(spaceId: 'west' | 'east'): Pose { return { spaceId, x: spaceId === 'west' ? -0.7 : 0.7, z: 0 }; }

/** Resolve a public world marker to the current static floor; shafts have no pose. */
export function poseAtWorld(board: (RoomId | null)[], point: Vec2): Pose | null {
  if (point.x >= -8 && point.x < -4 && point.z >= -4 && point.z <= 20) return { spaceId: 'west', x: point.x + 6, z: point.z - 8 };
  if (point.x > 20 && point.x <= 24 && point.z >= -4 && point.z <= 20) return { spaceId: 'east', x: point.x - 22, z: point.z - 8 };
  const c = Math.floor((point.x + 4) / 8), r = Math.floor((point.z + 4) / 8);
  if (c < 0 || c > 2 || r < 0 || r > 2) return null;
  const room = board[r * 3 + c];
  return room ? { spaceId: room, x: point.x - c * 8, z: point.z - r * 8 } : null;
}
