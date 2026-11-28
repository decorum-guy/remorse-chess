import { BenchError, SLOT_IDS } from './types';
import type { AxleId, Blueprint, Part, PartId, PresetId, SlotId } from './types';

export const BUDGET = 16;
export const CHASSIS_MASS = 3.2;
const axleSlots = ['front-axle', 'rear-axle'] as const;
const auxSlots = ['aux-left', 'aux-right'] as const;
export const PARTS: Record<PartId, Part> = {
  road: { id: 'road', name: {ru:'Дорожная ось',en:'Road axle'}, description:{ru:'Лёгкая. Держит сухой бетон.',en:'Light. Grips dry concrete.'}, cost:2,mass:0.9,slots:axleSlots,radius:0.23,lateralGrip:1,longitudinalGrip:1 },
  terrain: { id: 'terrain', name: {ru:'Грунтовая ось',en:'All-terrain axle'},description:{ru:'Уверенная тяга на мокром покрытии.',en:'Reliable grip on wet ground.'},cost:3,mass:1.2,slots:axleSlots,radius:0.27,lateralGrip:0.95,longitudinalGrip:1.1 },
  high: {id:'high',name:{ru:'Высокая ось',en:'High axle'},description:{ru:'Больше просвет. Выше центр тяжести.',en:'More clearance. Higher centre of mass.'},cost:4,mass:1.5,slots:axleSlots,radius:0.32,lateralGrip:0.82,longitudinalGrip:0.96},
  speed: {id:'speed',name:{ru:'Скоростной двигатель',en:'Speed motor'},description:{ru:'34 Н · 7,8 м/с · расход 1,05/с',en:'34 N · 7.8 m/s · 1.05 energy/s'},cost:3,mass:0.7,slots:['motor'],force:34,maxSpeed:7.8,consumption:1.05},
  torque: {id:'torque',name:{ru:'Тяговый двигатель',en:'Torque motor'},description:{ru:'58 Н · 5,5 м/с · расход 1,50/с',en:'58 N · 5.5 m/s · 1.50 energy/s'},cost:3,mass:1.1,slots:['motor'],force:58,maxSpeed:5.5,consumption:1.5},
  economy: {id:'economy',name:{ru:'Экономичный двигатель',en:'Economy motor'},description:{ru:'42 Н · 6,1 м/с · расход 0,75/с',en:'42 N · 6.1 m/s · 0.75 energy/s'},cost:2,mass:0.65,slots:['motor'],force:42,maxSpeed:6.1,consumption:0.75},
  small: {id:'small',name:{ru:'Малая батарея',en:'Small battery'},description:{ru:'29 единиц заряда',en:'29 energy'},cost:1,mass:0.45,slots:['battery'],capacity:29},
  large: {id:'large',name:{ru:'Большая батарея',en:'Large battery'},description:{ru:'47 единиц заряда',en:'47 energy'},cost:2,mass:1,slots:['battery'],capacity:47},
  platform: {id:'platform',name:{ru:'Платформа',en:'Cargo platform'},description:{ru:'3 гнезда · 100% удара · наклон до 37°',en:'3 sockets · 100% impact · 37° tilt'},cost:2,mass:0.55,slots:['cargo'],shockFactor:1,tiltLimit:37},
  cradle: {id:'cradle',name:{ru:'Пружинная люлька',en:'Spring cradle'},description:{ru:'3 гнезда · 58% удара · наклон до 42°',en:'3 sockets · 58% impact · 42° tilt'},cost:3,mass:1.05,slots:['cargo'],shockFactor:0.58,tiltLimit:42},
  clamp: {id:'clamp',name:{ru:'Активный зажим',en:'Active clamp'},description:{ru:'86% удара · до 58° · расход 0,28/с',en:'86% impact · 58° tilt · 0.28 energy/s'},cost:3,mass:1.2,slots:['cargo'],shockFactor:0.86,tiltLimit:58},
  'damper-front': {id:'damper-front',name:{ru:'Передний амортизатор',en:'Front damper'},description:{ru:'Ход +0,07 м · демпфирование +25%',en:'+0.07 m travel · +25% damping'},cost:2,mass:0.4,slots:auxSlots},
  'damper-rear': {id:'damper-rear',name:{ru:'Задний амортизатор',en:'Rear damper'},description:{ru:'Ход +0,07 м · демпфирование +25%',en:'+0.07 m travel · +25% damping'},cost:2,mass:0.4,slots:auxSlots},
  ballast: {id:'ballast',name:{ru:'Балласт',en:'Ballast'},description:{ru:'Низкая масса на выбранной стороне.',en:'Low-mounted mass on the chosen side.'},cost:1,mass:1.6,slots:auxSlots},
  rollbar: {id:'rollbar',name:{ru:'Защитная дуга',en:'Roll bar'},description:{ru:'Опоры помогают перекатиться с бока.',en:'Supports help roll back from a tip.'},cost:1,mass:0.55,slots:auxSlots},
};
export const PRESETS: Record<PresetId, Blueprint> = {
  universal: {'front-axle':'road','rear-axle':'road',motor:'economy',battery:'large',cargo:'platform','aux-left':null,'aux-right':null},
  gentle: {'front-axle':'terrain','rear-axle':'terrain',motor:'economy',battery:'small',cargo:'cradle','aux-left':'damper-front','aux-right':'rollbar'},
  tractor: {'front-axle':'terrain','rear-axle':'terrain',motor:'torque',battery:'large',cargo:'clamp','aux-left':'rollbar','aux-right':null},
};
export const PRESET_NAMES = { universal:{ru:'Универсал',en:'All-rounder'},gentle:{ru:'Бережная',en:'Gentle carrier'},tractor:{ru:'Тягач',en:'Hauler'} };
export const SLOT_NAMES: Record<SlotId,{ru:string;en:string}> = {
  'front-axle':{ru:'Передняя ось',en:'Front axle'},'rear-axle':{ru:'Задняя ось',en:'Rear axle'},motor:{ru:'Двигатель',en:'Motor'},battery:{ru:'Батарея',en:'Battery'},cargo:{ru:'Грузовой модуль',en:'Cargo module'},'aux-left':{ru:'Левое крепление',en:'Left mount'},'aux-right':{ru:'Правое крепление',en:'Right mount'},
};
export function blueprintCost(blueprint: Blueprint): number { return SLOT_IDS.reduce((sum,slot)=>sum+(blueprint[slot] ? PARTS[blueprint[slot]!].cost : 0),0); }
export function blueprintMass(blueprint: Blueprint): number { return CHASSIS_MASS+SLOT_IDS.reduce((sum,slot)=>sum+(blueprint[slot] ? PARTS[blueprint[slot]!].mass : 0),0); }
export function blueprintEdits(blueprint: Blueprint, previous: Blueprint | null): number { return previous ? SLOT_IDS.filter(slot=>blueprint[slot]!==previous[slot]).length : 0; }
export function validateBlueprint(input: unknown, previous: Blueprint | null = null): Blueprint {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BenchError('INVALID_BLUEPRINT');
  const values=input as Record<string,unknown>;
  if(Object.keys(values).length!==7) throw new BenchError('INVALID_BLUEPRINT');
  for(const slot of SLOT_IDS){
    const value=values[slot];
    if(value===null && (slot==='aux-left'||slot==='aux-right')) continue;
    if(typeof value!=='string'||!Object.hasOwn(PARTS,value)||!PARTS[value as PartId].slots.includes(slot)) throw new BenchError('INVALID_PART');
  }
  const blueprint={...values} as unknown as Blueprint;
  const aux=[blueprint['aux-left'],blueprint['aux-right']];
  for(const unique of ['rollbar','damper-front','damper-rear']) if(aux.filter(id=>id===unique).length>1) throw new BenchError('DUPLICATE_MODULE');
  if(blueprintCost(blueprint)>BUDGET) throw new BenchError('OVER_BUDGET');
  if(blueprintEdits(blueprint,previous)>2) throw new BenchError('TOO_MANY_EDITS');
  return blueprint;
}
export function partsForSlot(slot: SlotId): Part[] { return Object.values(PARTS).filter(part=>part.slots.includes(slot)); }

export function axleGrip(id:AxleId,wet:boolean):{lateral:number;longitudinal:number}{
  if(wet)return id==='terrain'?{lateral:0.85,longitudinal:0.9}:{lateral:0.54,longitudinal:0.64};
  return {lateral:PARTS[id].lateralGrip!,longitudinal:PARTS[id].longitudinalGrip!};
}
