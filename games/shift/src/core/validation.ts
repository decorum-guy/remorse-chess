import { getArena, ROOM_IDS } from './arenas';
import { coversFree, DRONE_RADIUS, movePose, pointFree } from './geometry';
import type { ArenaId, Pose, RoomId } from './types';
/** Prove metric intra-room routes first, then the entire reachable sliding-board graph. */
export function validateArena(arenaId: ArenaId, exhaustive = true): { arena: ArenaId; rooms: number; reachableBoards: number; shaftCells: number; failures: string[] } {
  const arena = getArena(arenaId), failures: string[] = [];
  for (const room of ROOM_IDS) {
    const nodes: Pose[] = [], lookup = new Map<string, number>();
    for (let iz = 0; iz <= 28; iz++) for (let ix = 0; ix <= 28; ix++) {
      const p = { spaceId: room, x: -3.5 + ix * 0.25, z: -3.5 + iz * 0.25 };
      if (coversFree(arenaId, p, DRONE_RADIUS + 0.03)) { lookup.set(`${ix},${iz}`, nodes.length); nodes.push(p); }
    }
    const start = lookup.get('14,14');
    if (start === undefined) { failures.push(`${room}: blocked pedestal/centre`); continue; }
    const visited = new Set<number>([start]), queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const p = nodes[queue[i]], ix = Math.round((p.x + 3.5) * 4), iz = Math.round((p.z + 3.5) * 4);
      for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const next = lookup.get(`${ix + dx},${iz + dz}`);
        if (next !== undefined && !visited.has(next)) {
          const np = nodes[next], reached = movePose(arenaId, arena.board, p, np.x - p.x, np.z - p.z);
          if (Math.hypot(reached.x - np.x, reached.z - np.z) < 0.001) { visited.add(next); queue.push(next); }
        }
      }
    }
    for (const key of ['14,0', '28,14', '14,28', '0,14']) { const index = lookup.get(key); if (index === undefined || !visited.has(index)) failures.push(`${room}: disconnected door approach ${key}`); }
    for (const c of arena.covers[room]) if (Math.abs(c.x) + c.width / 2 > 3.1 || Math.abs(c.z) + c.depth / 2 > 3.1) failures.push(`${room}: cover violates 0.9m door buffer`);
    for (const p of arena.pathNodes[room]) if (!pointFree(arenaId, arena.board, { spaceId: room, ...p })) failures.push(`${room}: unsafe authored path node`);
  }
  // Once all four ports within every module are connected, tile identity does not alter
  // topological reachability. Check each hole location and enumerate every legal permutation.
  const safeHole = new Set<number>();
  for (let hole = 0; hole < 9; hole++) {
    const start = hole === 0 ? 1 : 0, visited = new Set<number>([start]), queue = [start];
    for (let i = 0; i < queue.length; i++) for (const next of cellNeighbors(queue[i])) if (next !== hole && !visited.has(next)) { visited.add(next); queue.push(next); }
    if (visited.size !== 8 || [0, 3, 6].filter(i => i !== hole).length < 2 || [2, 5, 8].filter(i => i !== hole).length < 2) failures.push(`shaft ${hole}: disconnected delivery graph`);
    else safeHole.add(hole);
  }
  if (!exhaustive) return { arena: arenaId, rooms: ROOM_IDS.length, reachableBoards: 0, shaftCells: safeHole.size, failures };
  const initial = arena.board.map(r => r ?? '_').join(''), queue = [initial], seen = new Set([initial]);
  for (let i = 0; i < queue.length; i++) {
    const board = queue[i], hole = board.indexOf('_');
    if (!safeHole.has(hole)) failures.push(`unsafe reachable board ${board}`);
    for (const next of cellNeighbors(hole)) {
      const chars = board.split(''); [chars[hole], chars[next]] = [chars[next], chars[hole]]; const key = chars.join('');
      if (!seen.has(key)) { seen.add(key); queue.push(key); }
    }
  }
  return { arena: arenaId, rooms: ROOM_IDS.length, reachableBoards: seen.size, shaftCells: safeHole.size, failures };
}
function cellNeighbors(cell: number): number[] {
  const r = Math.floor(cell / 3), c = cell % 3, neighbors: number[] = [];
  if (r > 0) neighbors.push(cell - 3); if (r < 2) neighbors.push(cell + 3); if (c > 0) neighbors.push(cell - 1); if (c < 2) neighbors.push(cell + 1);
  return neighbors;
}
/** Validate supplied board data without accepting a duplicate or missing module. */
export function validBoard(board: (RoomId | null)[]): boolean { return board.length === 9 && board.filter(x => x === null).length === 1 && ROOM_IDS.every(room => board.filter(x => x === room).length === 1); }
