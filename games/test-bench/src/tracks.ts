import type { CargoKind, TrackDefinition, TrackId, Vec3 } from './types';

export const TRACK_ORDER: TrackId[] = ['fragile','precision','climb'];
export const CARGO_PROFILES: Record<CargoKind,{mass:number;threshold:number;multiplier:number;ejection:number;name:{ru:string;en:string}}> = {
  egg:{mass:0.16,threshold:0.55,multiplier:44,ejection:2.25,name:{ru:'Яйцо в капсуле',en:'Egg capsule'}},
  instrument:{mass:0.65,threshold:0.9,multiplier:30,ejection:2.7,name:{ru:'Измерительный блок',en:'Measuring block'}},
  'power-cell':{mass:1.15,threshold:1.05,multiplier:25,ejection:2.9,name:{ru:'Силовая ячейка',en:'Power cell'}},
};
export function getTrack(id: TrackId, mirrored=false): TrackDefinition {
  const sign=mirrored?-1:1;
  const common={id,mirrored,width:7.2,length:50,spawn:{x:0,z:0,yaw:0},loadingDock:{x:0,z:3,radius:1},ribs:[],restorePads:[]} as Pick<TrackDefinition,'id'|'mirrored'|'width'|'length'|'spawn'|'loadingDock'|'ribs'|'restorePads'>;
  let result:TrackDefinition;
  if(id==='precision') result={...common,name:{ru:'Точный манёвр',en:'Precision run'},description:{ru:'Четыре створа. Груз должен остаться на месте.',en:'Four gates. Keep the cargo on board.'},hazards:[{ru:'Чередующиеся ворота',en:'Alternating gates'},{ru:'Тормози перед поворотом',en:'Brake before turning'}],cargoKind:'instrument',orderedGates:[10,17,24,31].map((z,i)=>({id:`gate-${i+1}`,x:(i%2===0?-1.45:1.45)*sign,z,width:2.1})),unload:{minX:-1.8,maxX:1.8,minZ:41,maxZ:45}};
  else if(id==='climb') result={...common,name:{ru:'Подъём',en:'Uphill'},description:{ru:'Мокрый бетон и крутой пандус под грузом.',en:'Wet concrete and a loaded uphill climb.'},hazards:[{ru:'Сухая полоса у края',en:'Dry strip at the edge'},{ru:'Сохрани заряд для подъёма',en:'Save power for the slope'}],cargoKind:'power-cell',orderedGates:[22,36].map((z,i)=>({id:`gate-${i+1}`,x:0,z,width:7.2})),unload:{minX:-1.8,maxX:1.8,minZ:43,maxZ:47},ramp:{start:24,end:34,height:2.9,bevel:0.6},wet:{minZ:12,maxZ:21,drySide:sign as -1|1,dryWidth:1.05}};
  else result={...common,name:{ru:'Хрупкий груз',en:'Fragile cargo'},description:{ru:'Сохрани капсулы на рёбрах и невысоком мостике.',en:'Protect the capsules over ribs and a low bridge.'},hazards:[{ru:'Гладкий край меняет сторону',en:'Smooth edge switches sides'},{ru:'Медленнее на рёбрах',en:'Slow down over the ribs'}],cargoKind:'egg',orderedGates:[18,31].map((z,i)=>({id:`gate-${i+1}`,x:0,z,width:7.2})),unload:{minX:-1.8,maxX:1.8,minZ:42,maxZ:45},ramp:{start:19,end:22,height:0.35,downStart:26,downEnd:29},ribs:[11,12,13,14,15,33,34,35,36].map((z,i)=>({z,height:0.08+(i%3)*0.02,smoothSide:(z<20?-sign:sign) as -1|1}))};
  result.restorePads=[result.spawn,...result.orderedGates.map(g=>({x:g.x,z:g.z+1.2,yaw:0}))];
  return result;
}
export function groundHeight(track:TrackDefinition,x:number,z:number):number {
  let height=0;
  if(track.ramp){
    const r=track.ramp;const length=r.end-r.start;const distance=Math.max(0,Math.min(length,z-r.start));const bevel=Math.min(Math.max(0,r.bevel??0),length/2);
    if(bevel){const slope=r.height/(length-bevel);height=distance<bevel?slope*distance/2:distance<=length-bevel?slope*(distance-bevel/2):r.height-slope*(length-distance)/2;}
    else height=r.height*distance/length;
    if(r.downStart!==undefined&&r.downEnd!==undefined)height*=1-Math.max(0,Math.min(1,(z-r.downStart)/(r.downEnd-r.downStart)));
  }
  for(const rib of track.ribs){const dz=Math.abs(z-rib.z);if(dz<0.18){const smooth=x*rib.smoothSide>2.2; height+=(smooth?0.018:rib.height)*(1-dz/0.18);}}
  return height;
}
export function isWet(track:TrackDefinition,x:number,z:number):boolean {const wet=track.wet;return !!wet&&z>=wet.minZ&&z<=wet.maxZ&&x*wet.drySide<track.width/2-wet.dryWidth;}
export function crossedGate(previous:Vec3,current:Vec3,gate:{x:number;z:number;width:number}):boolean {
  if(previous.z>=gate.z||current.z<gate.z||current.z<=previous.z)return false;
  const t=(gate.z-previous.z)/(current.z-previous.z);const x=previous.x+(current.x-previous.x)*t;
  return Math.abs(x-gate.x)<=gate.width/2;
}
export function terrainMesh(track:TrackDefinition):{vertices:Float32Array;indices:Uint32Array}{
  const xs=[-3.6,-2.55,-2.2,0,2.2,2.55,3.6];const zs=new Set<number>([-5,53]);
  // Every height change is piecewise linear. Keep its exact corners instead
  // of serializing hundreds of redundant coplanar rows in every world.
  for(const rib of track.ribs)for(const offset of [-0.18,0,0.18])zs.add(rib.z+offset);
  if(track.ramp)for(const z of [track.ramp.start,track.ramp.end,track.ramp.downStart,track.ramp.downEnd])if(z!==undefined)zs.add(z);
  if(track.ramp?.bevel){const r=track.ramp;const bevel=Math.min(Math.max(0,r.bevel??0),(r.end-r.start)/2);zs.add(r.start+bevel);zs.add(r.end-bevel);}
  const zz=[...zs].sort((a,b)=>a-b);const vertices:number[]=[];const indices:number[]=[];
  for(const z of zz)for(const x of xs)vertices.push(x,groundHeight(track,x,z),z);
  for(let row=0;row<zz.length-1;row++)for(let col=0;col<xs.length-1;col++){const a=row*xs.length+col,b=a+1,c=a+xs.length,d=c+1;indices.push(a,c,b,b,c,d);}
  return {vertices:new Float32Array(vertices),indices:new Uint32Array(indices)};
}
