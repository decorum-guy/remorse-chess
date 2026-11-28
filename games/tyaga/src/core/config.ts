import type { EntityKind, GameMode, ItemKind, MapId, MaterialId, TyagaInput, Vec3 } from './types';
export const RULES_VERSION = 'tyaga@0.1';
export const CONTENT_VERSION = 'tyaga-expedition@4';
export const DT = 1 / 60;
export const PHYSICS_VERSION = 'rapier3d-compat@0.21.0';
export const SERIALIZER_VERSION = 1;
export const BOT_VERSION = 'tyaga-bots@2';
export const NEUTRAL_INPUT: TyagaInput = { moveX: 0, moveZ: 0, run: false, throttle: 0, steer: 0, brake: false, tool: 0 };
export const PHYSICS = {
  gravity: 9.81, characterMass: 80, characterHeight: 1.75, characterRadius: .3,
  walk: 3.2, run: 4.4, acceleration: 14, jump: 4.6, interact: 1.7, select: 4,
  handForce: 700, pushForce: 450, maxHandStretch: .65,
  truckMass: 1050, truckLength: 6.4, truckWidth: 2.6, wheelRadius: .5,
  wheelbase: 3.6, track: 2.1, suspensionTravel: .35, spring: 28000, damping: 3200,
  driveForce: 8000, brakeForce: 18000, forwardSpeed: 4.5, reverseSpeed: 2.5,
  steering: 32 * Math.PI / 180, loadCapacity: 2100,
  truckWinchForce: 14000, portableWinchForce: 10000, ropeBreakForce: 20000,
  ropeMax: 18, ropeMin: 1.5, ropeSegment: .75, ropeRadius: .04, ropeMass: 3,
  strapLimit: 9000, deckLimit: 42000, ringLimit: 30000, overloadTime: .25,
  jackForce: 15000, jackSpeed: .1, jackHeight: .8,
} as const;
export const FRICTION: Record<MaterialId, number> = { stone: .95, wood: .8, soil: .7, 'wet-stone': .55, mud: .35, ice: .15, steel: .8 };
export interface BodyProfile { mass: number; size: Vec3; name: { ru: string; en: string }; safeImpulse?: number; damageFactor?: number; model: string }
const body = (mass: number, x: number, y: number, z: number, ru: string, en: string, model: string, safeImpulse?: number, damageFactor?: number): BodyProfile => ({ mass, size: { x, y, z }, name: { ru, en }, model, safeImpulse, damageFactor });
export const BODY: Record<EntityKind, BodyProfile> = {
  truck: body(1050, 6.4, 1.6, 2.6, 'Тягач-6', 'Hauler-6', 'truck', 3, 1.5),
  character: body(80, .6, 1.75, .6, 'Экспедитор', 'Explorer', 'character'),
  'generator-large': body(750, 3.4, 2.2, 2.1, 'Большой генератор', 'Large generator', 'generator-large', 2.5, 2),
  mast: body(520, 7.2, 1, .9, 'Оптическая мачта', 'Optical mast', 'mast', 1.5, 6),
  'pump-large': body(900, 3.2, 2.7, 2.8, 'Насосная установка', 'Pump unit', 'pump-large', 2, 3),
  generator: body(180, 1.1, 1, .9, 'Генератор', 'Generator', 'generator', 2.5, 2),
  optics: body(80, .9, .9, .8, 'Оптический блок', 'Optical block', 'optics', 1.5, 6),
  pump: body(140, 1, 1, .9, 'Насос', 'Pump', 'pump', 2, 3),
  deck: body(110, 4, .18, 3, 'Настил', 'Deck', 'deck'),
  beam: body(24, 3, .3, .3, 'Балка', 'Beam', 'beam'),
  winch: body(35, .62, .55, .98, 'Лебёдка', 'Winch', 'winch'),
  anchor: body(12, .42, .85, .26, 'Якорь', 'Ground anchor', 'anchor'),
  strap: body(2, .42, .30, .14, 'Ремень', 'Strap', 'strap'),
  jack: body(18, .70, .72, .36, 'Домкрат', 'Jack', 'jack'),
  repair: body(6, .49, .42, .31, 'Ремонтный заряд', 'Repair kit', 'repair'),
  drive: body(40, 1.2, 1.2, .6, 'Переносной привод', 'Portable drive', 'drive'),
  crate: body(50, 4.6, .5, 2.2, 'Ящик оборудования', 'Equipment locker', 'crate'),
  pontoon: body(200, 6, .65, .8, 'Понтон', 'Pontoon', 'pontoon'),
  'ferry-deck': body(280, 8.4, .2, 4.2, 'Палуба парома', 'Ferry deck', 'ferry-deck'),
  lift: body(520, 8.4, .2, 4.2, 'Подъёмная платформа', 'Lift platform', 'lift'),
  block: body(280, 3.6, 1.2, 2.8, 'Бетонный блок', 'Concrete block', 'block'),
  ramp: body(80, 3, .18, 3.4, 'Аппарель', 'Ramp', 'ramp'),
  ring: body(0, .4, .4, .4, 'Скальное кольцо', 'Rock ring', 'ring'),
  hook: body(.08, .18, .22, .12, 'Крюк троса', 'Cable hook', 'hook'),
  'rope-segment': body(.125, .08, .75, .08, 'Трос', 'Cable', 'rope'),
  barrier: body(35, .12, .75, 3.4, 'Барьер', 'Barrier', 'barrier'),
};
export const ITEM_KINDS: ItemKind[] = ['deck', 'beam', 'winch', 'anchor', 'strap', 'jack', 'repair', 'drive'];
export function normalizeInput(value: unknown): TyagaInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT');
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in NEUTRAL_INPUT)) throw new Error('INVALID_INPUT');
  const result = { ...NEUTRAL_INPUT };
  for (const k of ['moveX', 'moveZ', 'throttle', 'steer', 'tool'] as const) {
    const v = o[k] ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1) throw new Error('INVALID_INPUT');
    result[k] = v;
  }
  for (const k of ['run', 'brake'] as const) { if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new Error('INVALID_INPUT'); result[k] = o[k] === true; }
  const len = Math.hypot(result.moveX, result.moveZ);
  if (len > 1) { result.moveX /= len; result.moveZ /= len; }
  return result;
}
export function normalizeTyagaSettings(value: unknown): { mapId: MapId; mode: GameMode; head: number; pack: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SETTINGS');
  const o = value as Record<string, unknown>;
  if (Object.keys(o).some(k => !['mapId', 'mode', 'head', 'pack'].includes(k))) throw new Error('INVALID_SETTINGS');
  const mapId = o.mapId ?? 'valley';
  if (!['valley','quarry','ridge','tutorial'].includes(String(mapId))) throw new Error('INVALID_MAP');
  const mode = o.mode ?? (mapId === 'tutorial' ? 'tutorial' : 'expedition');
  if (!['expedition','practice','tutorial'].includes(String(mode)) || (mode === 'tutorial') !== (mapId === 'tutorial')) throw new Error('INVALID_MODE');
  for (const k of ['head', 'pack']) if (o[k] !== undefined && o[k] !== 0 && o[k] !== 1) throw new Error('INVALID_APPEARANCE');
  return { mapId: mapId as MapId, mode: mode as GameMode, head: Number(o.head ?? 0), pack: Number(o.pack ?? 0) };
}
