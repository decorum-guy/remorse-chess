import type { Arena, ArenaId, Cover, RoomId, Vec2 } from './types';
export const ROOM_IDS: RoomId[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'O'];
const block = (x: number, z: number, width: number, depth: number, kind: Cover['kind'] = 'crate'): Cover => ({ x, z, width, depth, height: kind === 'pillar' ? 1.5 : 0.95, kind });
const mirror = (covers: Cover[]) => covers.map(c => ({ ...c, x: -c.x }));
function makeArena(id: ArenaId): Arena {
  const a = [block(-1.8, -1.45, 1.2, 1.25, 'machine'), block(1.8, 1.45, 1.2, 1.25, 'machine')];
  const b = [block(-1.85, 0.9, 1.1, 2.2, 'machine'), block(1.75, -1.45, 1.05, 1.05)];
  const f = [block(-2, -1.75, 1.2, 1.1), block(2.25, 1.75, 0.65, 0.65, 'pillar')];
  const o = id === 'calibration' ? [-1.65, 1.65].flatMap(x => [-1.7, 1.7].map(z => block(x, z, 0.8, 0.8, 'pillar'))) : [-1, 1].map(sign => block(sign * (id === 'depot' ? 1.55 : 1.65), 0, id === 'depot' ? 1.15 : 0.9, id === 'depot' ? 2.05 : 1.3, 'machine'));
  const covers = { A: a, E: mirror(a), B: b, D: mirror(b), F: f, G: mirror(f), C: [-1, 1].map(s => block(s * 1.75, 0, 1.05, 1.45)), O: o };
  // Fixed metric path nodes are part of the arena source, shared by bots and validators.
  const pathNodes = Object.fromEntries(ROOM_IDS.map(room => {
    const nodes: Vec2[] = [];
    for (let z = -3; z <= 3; z += 0.5) for (let x = -3; x <= 3; x += 0.5) {
      if (!covers[room].some(c => Math.abs(x - c.x) < c.width / 2 + 0.32 && Math.abs(z - c.z) < c.depth / 2 + 0.32)) nodes.push({ x, z });
    }
    nodes.push({ x: 0, z: -3.6 }, { x: 3.6, z: 0 }, { x: 0, z: 3.6 }, { x: -3.6, z: 0 });
    return [room, nodes];
  })) as Record<RoomId, Vec2[]>;
  return {
    id,
    title: id === 'foundry' ? { ru: 'Крановый цех', en: 'Crane Foundry' } : id === 'calibration' ? { ru: 'Калибровка', en: 'Calibration' } : { ru: 'Склад модулей', en: 'Module Depot' },
    board: id === 'foundry' ? ['B', 'C', 'D', 'A', 'O', 'E', 'F', null, 'G'] : id === 'calibration' ? ['F', null, 'G', 'B', 'O', 'D', 'A', 'C', 'E'] : ['A', 'C', 'E', 'F', 'O', 'G', 'B', null, 'D'],
    covers, pathNodes, spawnPoints: { west: [{ x: -0.7, z: -0.8 }, { x: -0.7, z: 0.8 }], east: [{ x: 0.7, z: 0.8 }, { x: 0.7, z: -0.8 }] },
  };
}
export const ARENAS: Record<ArenaId, Arena> = { foundry: makeArena('foundry'), calibration: makeArena('calibration'), depot: makeArena('depot') };
export function getArena(id: ArenaId): Arena { return ARENAS[id]; }
