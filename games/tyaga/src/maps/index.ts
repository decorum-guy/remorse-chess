import type { AnchorDefinition, MapId, MapZone, MaterialId, RoadEdge, RoadNode, Surface, TyagaMap, Vec3 } from '../core/types';
import { add, clamp, mix, Q, quatAxis, quatMul, rotate, V } from '../core/math';

const vec = (p: readonly number[]): Vec3 => V(p[0], p[1], p[2]);
const zone = (id: string, p: readonly number[], ru: string, en: string, x = 14, z = 14): MapZone => ({ id, position: vec(p), size: V(x, 12, z), label: { ru, en } });
class Builder {
  surfaces: Surface[] = [];
  anchors: AnchorDefinition[] = [];
  nodes: RoadNode[] = [];
  edges: RoadEdge[] = [];
  serial = 0;
  box(id: string, p: Vec3, size: Vec3, material: MaterialId = 'soil', kind: Surface['kind'] = 'pad'): void {
    this.surfaces.push({ id, position: add(p, V(0, -size.y / 2, 0)), size, rotation: Q(), material, kind });
  }
  pad(id: string, p: readonly number[], x = 14, z = 14, material: MaterialId = 'soil'): void { this.box(id, vec(p), V(x, 1, z), material);this.nodes.push({id:`pad:${id}`,position:vec(p)}); }
  road(id: string, points: readonly (readonly number[])[], width: number, material: MaterialId = 'soil', edgeKind: RoadEdge['kind'] = 'road', bank = 0): void {
    for (let n = 0; n < points.length; n++) {
      const p = vec(points[n]); const nodeId = `${id}:${n}`;
      this.nodes.push({ id: nodeId, position: p });
      if (!n) continue;
      const a = vec(points[n - 1]); const b = p;
      const horizontal = Math.hypot(b.x - a.x, b.z - a.z);
      const length = Math.hypot(horizontal, b.y - a.y);
      if (length < .001) continue;
      const yaw = -Math.atan2(b.z - a.z, b.x - a.x);
      const pitch = Math.atan2(b.y - a.y, horizontal);
      const q = quatMul(quatMul(quatAxis(V(0, 1, 0), yaw), quatAxis(V(0, 0, 1), pitch)), quatAxis(V(1, 0, 0), bank));
      const thickness = edgeKind === 'walk' ? .35 : 1;
      this.surfaces.push({ id: `${id}-surface-${n}`, position: add(mix(a, b, .5), rotate(q, V(0, -thickness / 2, 0))), rotation: q, size: V(length + .06, thickness, width), material, kind: edgeKind === 'walk' ? 'step' : 'road' });
      this.edges.push({ from: `${id}:${n - 1}`, to: nodeId, width, kind: edgeKind, bidirectional: true });
    }
  }
  ring(id: string, p: readonly number[], limit = 30000): void { this.anchors.push({ id, position: vec(p), limit }); }
  bridge(id: string, centers: number[], y: number, z: number): void {
    for (const x of centers) for (const end of [-1, 1]) for (const side of [-1, 1]) this.anchors.push({ id: `${id}-mount-${x}-${end}-${side}`, position: V(x + 1.8 * end, y + .18, z + 1.25 * side), limit: 42000, mount: 'deck' });
  }
  connectGraphs(): { nodes: RoadNode[]; edges: RoadEdge[] } {
    // Merge graph junctions through their actual common road/pad geometry. This
    // graph only plans; a wheel/foot ground query still gates every traversal.
    const edges = [...this.edges];
    for (let i = 0; i < this.nodes.length; i++) for (let j = i + 1; j < this.nodes.length; j++) {
      const a = this.nodes[i].position, b = this.nodes[j].position;
      if (Math.hypot(a.x - b.x, a.z - b.z) < 2.5 && Math.abs(a.y - b.y) < .8) edges.push({ from: this.nodes[i].id, to: this.nodes[j].id, width: 1.2, kind: [this.nodes[i].id,this.nodes[j].id].some(id=>/pad:(river-step|upper-foot)/.test(id))?'jump':'walk', bidirectional: true });
    }
    return { nodes: this.nodes, edges };
  }
}

/** A closed, visible terrain solid. Its top and its collision use the same
 * sampled grades; the bottom is the real bedrock, not a second hidden box. */
function gradedRoad(id:string,a:Vec3,b:Vec3,width:number,bottom:number,height:(x:number,z:number,t:number)=>number):Surface{
  const dx=b.x-a.x,dz=b.z-a.z,length=Math.hypot(dx,dz),nx=-dz/length,nz=dx/length;
  const along=Math.ceil(length/.5),across=Math.ceil(width/.5),row=across+1,top:Vec3[]=[];
  for(let i=0;i<=along;i++)for(let j=0;j<=across;j++){
    const t=i/along,side=(j/across-.5)*width,x=a.x+dx*t+nx*side,z=a.z+dz*t+nz*side;
    top.push(V(x,height(x,z,t),z));
  }
  const points=[...top,...top.map(p=>V(p.x,bottom,p.z))],indices:number[]=[],count=top.length;
  for(let i=0;i<along;i++)for(let j=0;j<across;j++){
    const k=i*row+j;indices.push(k,k+1,k+row,k+1,k+row+1,k+row);
    indices.push(k+count,k+row+count,k+1+count,k+1+count,k+row+count,k+row+1+count);
  }
  const boundary=[...Array.from({length:row},(_,j)=>j),...Array.from({length:along},(_,i)=>(i+1)*row+across),...Array.from({length:across},(_,j)=>along*row+across-j-1),...Array.from({length:along-1},(_,i)=>(along-i-1)*row)];
  for(let i=0;i<boundary.length;i++){const k=boundary[i],next=boundary[(i+1)%boundary.length];indices.push(k,next+count,next,k,k+count,next+count);}
  const min=V(Math.min(...points.map(p=>p.x)),bottom,Math.min(...points.map(p=>p.z))),max=V(Math.max(...points.map(p=>p.x)),Math.max(...top.map(p=>p.y)),Math.max(...points.map(p=>p.z))),position=mix(min,max,.5);
  return{id,position,rotation:Q(),size:V(max.x-min.x,max.y-min.y,max.z-min.z),material:'wet-stone',kind:'road',mesh:{vertices:points.flatMap(p=>[p.x-position.x,p.y-position.y,p.z-position.z]),indices}};
}

function valley(): TyagaMap {
  const b = new Builder();
  b.pad('start-pad', [12, 0, 32], 18, 16);
  b.road('start-road', [[12,0,32],[32,0,32],[44.5,0,32]], 6);
  b.road('bridge-exit', [[51.5,0,32],[76,0,32],[94,0,32]], 6);
  b.pad('central-pier', [48,0,32], 1, 4, 'stone');
  b.bridge('valley-bridge', [46,50],0,32);
  for (let i = 0; i < 5; i++) b.pad(`river-step-${i}`, [43.5 + i * 2.15,.1,35.6], 1.2,1.2,'stone');
  for(const [id,x]of [['near',43.5],['far',52.1]]as const)b.nodes.push({id:`river-foot-${id}`,position:V(x,0,34.2)});
  b.edges.push({from:'start-road:2',to:'river-foot-near',width:1.2,kind:'walk',bidirectional:true},{from:'bridge-exit:0',to:'river-foot-far',width:1.2,kind:'walk',bidirectional:true});
  b.road('ford', [[32,0,32],[36,-.2,50],[60,-.2,50],[68,0,32]],5,'mud');
  b.pad('ford-turn-1',[36,-.2,50],7,7,'mud'); b.pad('ford-turn-2',[60,-.2,50],9,9,'mud');
  // A real passing bay skirts the fixed rock eye. The canonical ford remains
  // five metres wide; this local turnout gives all four wheels physical room.
  b.road('ford-turnout',[[60,-.2,50],[64,-.1,41]],7.5,'mud');
  b.edges.push({from:'ford-turnout:1',to:'ford:3',width:5,kind:'road',bidirectional:true});
  b.road('hill',[[94,0,32],[102,1,32],[110,5,32],[118,6,32],[132,6,32]],4,'stone');
  b.road('hill-bypass',[[90,0,32],[90,0,16],[122,6,16],[126,6,32]],4);
  b.pad('hill-corner-a',[90,0,16],8,8); b.pad('hill-corner-b',[122,6,16],8,8);
  b.pad('checkpoint-a',[76,0,32]); b.pad('checkpoint-b',[132,6,32]);
  b.road('final-approach',[[132,6,32],[146,6,32]],6);
  b.road('final-step',[[146,6.55,32],[151,6.55,32]],6,'stone');
  b.road('final-exit',[[151,6,32],[168,6,32]],6);
  b.road('final-bypass',[[140,6,32],[147,6,43],[156,6,43],[161,6,32]],4);
  b.pad('finish-pad',[168,6,32],16,14,'wood');
  b.ring('ford-near-ring',[40,.4,54]); b.ring('ford-far-ring',[62,.4,46]); b.ring('hill-ring',[115,6.5,32]);
  b.road('ford-near-foot',[[36,-.2,50],[40,.1,54]],1.2,'stone','walk');
  b.road('ford-far-foot',[[60,-.2,50],[62,.1,46]],1.2,'stone','walk');
  b.road('hill-foot',[[101,1,29],[107,3.5,29],[115,6,30],[115,6,32]],1.2,'stone','walk');
  const graph = b.connectGraphs();
  return { id:'valley',version:'valley@3',name:{ru:'Мостовая долина',en:'Bridge Valley'},subtitle:{ru:'Две переправы. Один большой генератор.',en:'Two crossings. One enormous generator.'},bounds:V(180,40,64),abyssY:-12,start:V(12,0,32),surfaces:b.surfaces,anchors:b.anchors,
    waterVolumes:[{id:'river',min:V(43,-4,24),max:V(53,0,57),baseLevel:0,amplitude:0,period:90,flow:V()}],
    checkpoints:[zone('valley-cp1',[76,0,32],'Долинная стоянка','Valley camp'),zone('valley-cp2',[132,6,32],'Стоянка на плато','Plateau camp')],finish:zone('valley-finish',[168,6,32],'Станция «Долина»','Valley station',16,14),
    roadGraph:graph,footGraph:graph,cargo:['generator-large','optics','pump'],tools:{deck:4,beam:4,winch:1,anchor:4,strap:10,jack:2,repair:6},startBodies:[],windProfile:null,
    bridges:[{id:'valley-bridge',centers:[V(46,0,32),V(50,0,32)],length:4,width:3}],
    routes:[{id:'valley-bridge',name:{ru:'Мост и крутой подъём',en:'Bridge and steep climb'},points:[[12,0,32],[42,0,32],[54,0,32],[76,0,32],[101,1,32],[118,6,32],[132,6,32],[146,6,32],[168,6,32]].map(vec)},
      {id:'valley-ford',name:{ru:'Брод и длинный объезд',en:'Ford and long bypass'},points:[[12,0,32],[32,0,32],[36,-.2,50],[61.5,-.2,51],[64.7,-.1,43],[68,0,32],[76,0,32],[90,0,32],[90,0,16],[122,6,16],[126,6,32],[132,6,32],[140,6,32],[147,6,43],[156,6,43],[161,6,32],[168,6,32]].map(vec)}] };
}

function quarry(): TyagaMap {
  const b = new Builder();
  b.pad('start-pad',[12,0,48],18,16);
  b.road('quarry-entry',[[12,0,48],[30,0,48],[45,-4,48],[72,-4,48],[90,0,48],[100,0,48],[120,0,48]],5,'wet-stone');
  b.road('upper-near',[[30,0,48],[36,1,24],[52.5,1,24]],4,'stone'); b.pad('upper-near-turn',[36,1,24],8,8);
  b.road('upper-far',[[59.5,1,24],[75,1,24],[90,0,48]],4,'stone'); b.pad('upper-far-turn',[75,1,24],8,8);
  b.pad('upper-pier',[56,1,24],1,4,'stone'); b.bridge('quarry-bridge',[54,58],1,24);
  for (let i=0;i<5;i++) b.pad(`upper-foot-${i}`,[51.5+i*2.15,1.1,27.6],1.2,1.2,'stone');
  for(const [id,x]of [['near',51.5],['far',60.1]]as const)b.nodes.push({id:`upper-foot-${id}`,position:V(x,1,25.5)});
  b.edges.push({from:'upper-near:2',to:'upper-foot-near',width:1.2,kind:'walk',bidirectional:true},{from:'upper-far:0',to:'upper-foot-far',width:1.2,kind:'walk',bidirectional:true});
  b.road('ferry-near-approach',[[30,0,48],[36,-2.8,60],[36,-2.8,64]],8,'wet-stone');
  b.pad('ferry-near-landing',[36,-2.8,60],8,8,'wet-stone');
  // An open service recess beside the ramp lets the real outboard leg enter
  // the water; a solid pier here would occupy the stern mounting volume.
  b.pad('ferry-near-dock',[34.6,-2.8,64],6.2,8,'wood');
  b.pad('ferry-near-dock-ramp-wing',[38.1,-2.8,62.75],.8,5.5,'wood');
  b.pad('ferry-near-dock-outer-wing',[38.1,-2.8,67.55],.8,.9,'wood');
  b.road('ferry-far-approach',[[84,-2.8,64],[90,0,48]],8,'wet-stone'); b.pad('ferry-far-dock',[86,-2.8,64],4,8,'wood');
  const junction=b.surfaces.findIndex(s=>s.id==='ferry-far-approach-surface-1');
  b.surfaces[junction]=gradedRoad('ferry-far-approach-surface-1',V(84,-2.8,64),V(90,0,48),8,-21,(x,z,t)=>{
    const main=-4+4*clamp((x-72)/18,0,1),u=clamp((54-z)/3.5,0,1),weight=u*u*(3-2*u);
    return(-2.8+2.8*t)*(1-weight)+main*weight;
  });
  const upperJunction=b.surfaces.findIndex(s=>s.id==='upper-far-surface-2');
  b.surfaces[upperJunction]=gradedRoad('upper-far-surface-2',V(75,1,24),V(90,0,48),4,-21,(x,z,t)=>{
    const main=-4+4*clamp((x-72)/18,0,1),u=clamp((z-42)/3.5,0,1),weight=u*u*(3-2*u);
    return(1-t)*(1-weight)+main*weight;
  });
  b.pad('checkpoint-a',[100,0,48]); b.pad('checkpoint-b',[162,4,48]);
  // One-metre bank segments join without a vertical seam.
  for(let x=120;x<146;x++) { const bank0=Math.min(1,(x-120)/4,(146-x)/6)*18*Math.PI/180;
    b.road(`shelf-${x}`,[[x,(x-120)*4/26,48],[x+1,(x+1-120)*4/26,48]],4,'wet-stone','road',Math.max(0,bank0)); }
  b.road('shelf-exit',[[146,4,48],[162,4,48]],5,'wet-stone');
  b.road('shelf-bypass-near',[[114,0,48],[120,0,76],[134,14*4/31,76]],5);
  b.road('shelf-bypass-far',[[137.2,17.2*4/31,76],[151,4,76],[154,4,48]],5); b.pad('shelf-turn-a',[120,0,76],8,8); b.pad('shelf-turn-b',[151,4,76],8,8);
  b.bridge('quarry-ditch',[135.6],16*4/31,76);
  b.road('quarry-final',[[162,4,48],[186,4,48],[210,4,48]],5,'stone'); b.pad('block-pocket',[186,4,39],9,8,'stone');
  b.road('block-pocket-road',[[186,4,48],[186,4,39]],4,'stone');
  b.road('block-bypass',[[178,4,48],[183,4,58],[194,4,58],[199,4,48]],3.6,'stone');
  b.pad('finish-pad',[210,4,48],16,14,'wood');
  b.ring('water-ring-1',[44,-2.8,43]); b.ring('water-ring-2',[60,-2.8,43]); b.ring('water-ring-3',[76,-1.2,43]);
  b.road('water-foot',[[42,-2.9,43],[60,-2.9,43],[76,-1.3,43],[82,-16/9,43]],1.2,'wet-stone','walk');
  // Visible, narrow approaches join the existing footpath to the real road
  // edges. They do not provide a second truck crossing. The far approach
  // shares the road's cross-grade, avoiding a vertical lip at the junction.
  b.road('water-foot-near',[[40,-8/3,45.5],[42,-2.9,43]],1.2,'wet-stone','walk');
  b.road('water-foot-far',[[82,-16/9,43],[82,-16/9,45.5]],1.2,'wet-stone','walk',Math.atan2(4,18));
  b.edges.push({from:'quarry-entry:1',to:'water-foot-near:0',width:1.2,kind:'walk',bidirectional:true},{from:'water-foot-far:1',to:'quarry-entry:4',width:1.2,kind:'walk',bidirectional:true});
  b.ring('ferry-near-ring',[38,-2.5,60]); b.ring('ferry-far-ring',[84,-2.5,68]);
  b.ring('shelf-ring-1',[124,2,44]); b.ring('shelf-ring-2',[140,4.5,44]);
  b.road('shelf-foot',[[119,0,44],[124,1.6,44],[140,4.1,44],[148,4,44]],1.2,'stone','walk');
  b.pad('equipment-niche',[82,1,20],5,5,'stone'); b.road('equipment-foot',[[75,1,24],[82,1,20]],1.2,'stone','walk');
  const graph=b.connectGraphs();
  return {id:'quarry',version:'quarry@4',name:{ru:'Затопленный карьер',en:'Flooded Quarry'},subtitle:{ru:'Мачта, мокрый камень и свой паром.',en:'A long mast, wet rock and your own ferry.'},bounds:V(224,40,96),abyssY:-18,start:V(12,0,48),surfaces:b.surfaces,anchors:b.anchors,
    waterVolumes:[{id:'low-water',min:V(44,-4,40),max:V(76,-3.2,54),baseLevel:-3.2,amplitude:.25,period:90,flow:V(0,0,250)},{id:'ferry-basin',min:V(38,-6,56),max:V(86,-3.2,72),baseLevel:-3.2,amplitude:.25,period:90,flow:V(0,0,250)},{id:'ferry-service-well',min:V(37.7,-6,65.5),max:V(38,-3.2,67.1),baseLevel:-3.2,amplitude:.25,period:90,flow:V(0,0,250)}],
    checkpoints:[zone('quarry-cp1',[100,0,48],'Верхняя стоянка','Upper camp'),zone('quarry-cp2',[162,4,48],'Каменная стоянка','Stone camp')],finish:zone('quarry-finish',[210,4,48],'Станция «Карьер»','Quarry station',16,14),roadGraph:graph,footGraph:graph,
    cargo:['mast','generator','pump'],tools:{deck:3,beam:6,winch:1,anchor:6,strap:12,jack:2,repair:8},windProfile:null,
    startBodies:[{id:'ferry-deck',kind:'ferry-deck',position:V(43,-2.4,64)},{id:'pontoon-left',kind:'pontoon',position:V(43,-2.9167,62.3)},{id:'pontoon-right',kind:'pontoon',position:V(43,-2.9167,66.4)},
      {id:'ferry-drive',kind:'drive',position:V(36,-2.1,60)},{id:'near-ramp',kind:'ramp',position:V(36+1.5*Math.cos(.17),-2.71+1.5*Math.sin(.17),64),rotation:quatAxis(V(0,0,1),.17)},{id:'far-ramp',kind:'ramp',position:V(82.6,-2.7,64)},
      {id:'road-block',kind:'block',position:V(186,4.6,48)},{id:'found-beam-1',kind:'beam',position:V(81,1.15,20)},{id:'found-beam-2',kind:'beam',position:V(83,1.15,20)},{id:'found-repair',kind:'repair',position:V(82,1.13,21)}],
    bridges:[{id:'quarry-bridge',centers:[V(54,1,24),V(58,1,24)],length:4,width:3},{id:'quarry-ditch',centers:[V(135.6,16*4/31,76)],length:4,width:3}],
    routes:[{id:'quarry-low',name:{ru:'Низкая вода и страховка',en:'Low water and safety cables'},points:[[12,0,48],[30,0,48],[45,-4,48],[72,-4,48],[90,0,48],[100,0,48],[120,0,48],[146,4,48],[162,4,48],[180,4,48],[192,4,48],[210,4,48]].map(vec)},
      {id:'quarry-upper',name:{ru:'Верхний мост и обход',en:'Upper bridge and bypass'},points:[[12,0,48],[30,0,48],[36,1,24],[52,1,24],[61,1,24],[75,1,24],[90,0,48],[100,0,48],[114,0,48],[120,0,76],[133,1.7,76],[139,2.4,76],[151,4,76],[154,4,48],[162,4,48],[178,4,48],[183,4,58],[194,4,58],[199,4,48],[210,4,48]].map(vec)},
      {id:'quarry-ferry',name:{ru:'Паром и наклонная полка',en:'Ferry and sloping shelf'},points:[[12,0,48],[30,0,48],[36,-2.8,64],[43,-2.8,64],[80,-2.8,64],[84,-2.8,64],[90,0,48],[100,0,48],[120,0,48],[146,4,48],[162,4,48],[186,4,48],[210,4,48]].map(vec)}]};
}

function ridge(): TyagaMap {
  const b=new Builder();
  b.pad('start-pad',[12,0,52],18,16);
  b.road('ridge-entry',[[12,0,52],[30,0,52],[44,2,52],[64,10,52],[78,10,52],[92,10,52],[115.5,10,52]],4.5,'stone');
  b.road('first-bypass',[[30,0,52],[30,0,26],[60,6,26],[82,10,40],[84,10,52]],4);
  b.pad('first-turn-a',[30,0,26],9,9);b.pad('first-turn-b',[60,6,26],9,9);b.pad('first-turn-c',[82,10,40],9,9);
  b.pad('checkpoint-a',[92,10,52]);
  b.pad('ridge-pier-a',[119,10,52],1,4,'steel'); b.pad('ridge-pier-b',[123,10,52],1,4,'steel');
  b.bridge('ridge-bridge',[117,121,125],10,52);
  b.road('gorge-exit',[[126.5,10,52],[164,10,52],[200,10,52]],4.5,'stone');
  b.road('gorge-foot-near',[[113,10,52],[113,10,56.3],[114.5,10,56.3]],1.2,'steel','walk');
  b.road('gorge-foot-far',[[127.5,10,56.3],[129,10,56.3],[129,10,52]],1.2,'steel','walk');
  // A visible 1.2m service catwalk reaches both piers; width excludes trucks.
  b.road('gorge-foot',[[114.5,10,56.3],[119,10,56.3],[123,10,56.3],[127.5,10,56.3]],1.2,'steel','walk');
  for(const x of [119,123]) b.road(`pier-foot-${x}`,[[x,10,56.3],[x,10,52]],1.2,'steel','walk');
  b.road('lower-entry',[[104,10,52],[108,8,82],[116.5,8,82]],3.4,'stone');
  b.road('lower-step-a',[[116.5,8.55,82],[118.5,8.55,82]],3.4,'stone');
  b.road('lower-middle',[[118.5,8,82],[130.5,8,82]],3.4,'stone');
  b.road('lower-step-b',[[130.5,8.55,82],[132.5,8.55,82]],3.4,'stone');
  b.road('lower-exit',[[132.5,8,82],[138,8,82],[150,10,52]],3.4,'stone');
  b.pad('lower-turn-a',[108,8,82],9,9);b.pad('lower-turn-b',[138,8,82],9,9);
  b.pad('checkpoint-b',[164,10,52]);
  b.road('last-climb',[[200,10,52],[215,16,52],[242,16,52]],4,'stone');
  b.road('last-bypass',[[182,10,52],[188,10,28],[224,16,28],[232,16,52]],4);
  b.pad('last-turn-a',[188,10,28],9,9);b.pad('last-turn-b',[224,16,28],9,9);
  b.road('lift-near',[[192,10,52],[202,10,72],[217.8,10,72]],4,'steel');b.pad('lift-near-turn',[202,10,72],9,9,'stone');
  b.road('lift-far',[[226.28,16,72],[230,16,72],[238,16,52]],4,'steel');
  b.pad('lift-equipment-pad',[212,10,68],7,6,'stone');
  // Rail geometry is real. The platform's constrained axes represent its
  // four guide shoes, while its vertical drive remains force-limited.
  for(const x of [217.4,226.6]) for(const z of [69.5,74.5]) b.surfaces.push({id:`lift-guide-${x}-${z}`,position:V(x,15.75,z),rotation:Q(),size:V(.3,11.5,.3),material:'steel',kind:'frame'});
  b.surfaces.push({id:'lift-top-frame',position:V(222,21.65,72),rotation:Q(),size:V(9.5,.3,5.3),material:'steel',kind:'frame'});
  // 0.22m steps, with full collision, make the fixed transmission reachable.
  const stepCount=28;
  for(let i=0;i<stepCount;i++) b.box(`lift-stair-${i}`,V(210.56+i*.26,10+Math.min(6,(i+1)*.22),67),V(.28,.24,1.2),'steel','step');
  b.road('lift-top-foot',[[217.6,16,67],[222,16,67],[222,16,69.3]],1.2,'steel','walk');
  b.pad('finish-pad',[242,16,52],16,14,'wood');
  b.ring('climb-ring-1',[48,4,49]);b.ring('climb-ring-2',[67,10.5,49]);b.ring('last-ring',[219,16.5,49]);
  b.road('climb-foot',[[39,1,49],[48,3.6,49],[67,10.1,49],[76,10,49]],1.2,'stone','walk');
  b.road('last-foot',[[198,10,49],[219,16.1,49]],1.2,'stone','walk');
  const graph=b.connectGraphs();
  return {id:'ridge',version:'ridge@2',name:{ru:'Ветровой хребет',en:'Wind Ridge'},subtitle:{ru:'Большой насос. Высота. Ветер.',en:'A giant pump. Height. Wind.'},bounds:V(260,56,104),abyssY:-30,start:V(12,0,52),surfaces:b.surfaces,anchors:b.anchors,waterVolumes:[],
    checkpoints:[zone('ridge-cp1',[92,10,52],'Стоянка у ущелья','Gorge camp'),zone('ridge-cp2',[164,10,52],'Высокая стоянка','High camp')],finish:zone('ridge-finish',[242,16,52],'Станция «Хребет»','Ridge station',16,14),roadGraph:graph,footGraph:graph,
    cargo:['pump-large','generator','optics'],tools:{deck:4,beam:4,winch:1,anchor:4,strap:12,jack:2,repair:8},
    startBodies:[{id:'lift-platform',kind:'lift',position:V(222,10.1,72),mass:450},{id:'lift-drive',kind:'drive',position:V(212,10.65,68)},{id:'lift-barrier-near',kind:'barrier',position:V(217.9,10.6,72)},{id:'lift-barrier-far',kind:'barrier',position:V(226.1,10.6,72)}],
    windProfile:{base:35,gust:180,period:24,duration:6,warning:3,firstCalm:12,direction:V(0,0,1)},
    bridges:[{id:'ridge-bridge',centers:[V(117,10,52),V(121,10,52),V(125,10,52)],length:4,width:3}],
    routes:[{id:'ridge-direct',name:{ru:'Тяга, мост и разгрузка',en:'Winch, bridge and unloading'},points:[[12,0,52],[30,0,52],[44,2,52],[64,10,52],[92,10,52],[114,10,52],[128,10,52],[164,10,52],[200,10,52],[215,16,52],[242,16,52]].map(vec)},
      {id:'ridge-bypass',name:{ru:'Серпантин и нижняя полка',en:'Switchbacks and lower ledge'},points:[[12,0,52],[30,0,52],[30,0,26],[60,6,26],[82,10,40],[84,10,52],[92,10,52],[104,10,52],[108,8,82],[117,8,82],[131,8,82],[138,8,82],[150,10,52],[164,10,52],[182,10,52],[188,10,28],[224,16,28],[232,16,52],[242,16,52]].map(vec)},
      {id:'ridge-lift',name:{ru:'Серпантин, мост и подъёмник',en:'Switchbacks, bridge and lift'},points:[[12,0,52],[30,0,52],[30,0,26],[60,6,26],[82,10,40],[84,10,52],[92,10,52],[114,10,52],[128,10,52],[164,10,52],[192,10,52],[202,10,72],[222,10,72],[222,16,72],[230,16,72],[238,16,52],[242,16,52]].map(vec)}]};
}

function tutorial(): TyagaMap {
  const b=new Builder();b.pad('training-ground',[24,0,18],48,36);
  b.road('training-slope',[[23,0,18],[29,1.5,18],[35,1.5,18]],5,'stone'); b.pad('training-slope-top',[35,1.5,18],7,7);
  b.ring('training-ring',[34,1.8,14]);
  b.pad('training-support-a',[34,0,28],1,4,'stone');b.pad('training-support-b',[37,0,28],1,4,'stone');b.bridge('training-bridge',[35.5],0,28);
  const graph=b.connectGraphs();
  return {id:'tutorial',version:'tutorial@2',name:{ru:'Учебная площадка',en:'Training grounds'},subtitle:{ru:'Восемь дел перед экспедицией.',en:'Eight practical steps before the expedition.'},bounds:V(48,15,36),abyssY:-8,start:V(12,0,18),surfaces:b.surfaces,anchors:b.anchors,waterVolumes:[],
    checkpoints:[zone('tutorial-cp',[35,0,8],'Учебная стоянка','Training camp')],finish:zone('tutorial-finish',[35,0,8],'Учебная площадка','Training grounds'),roadGraph:graph,footGraph:graph,
    cargo:['generator-large','optics','pump'],tools:{deck:4,beam:4,winch:1,anchor:4,strap:14,jack:2,repair:6},
    startBodies:[{id:'training-light',kind:'beam',position:V(13,.2,22),mass:24},{id:'training-heavy',kind:'deck',position:V(17,.15,24)},{id:'training-anchor',kind:'anchor',position:V(25,.4,14)}],windProfile:null,
    bridges:[{id:'training-bridge',centers:[V(35.5,0,28)],length:4,width:3}],routes:[]};
}

export const TYAGA_MAPS: Record<MapId, TyagaMap> = { valley:valley(),quarry:quarry(),ridge:ridge(),tutorial:tutorial() };
// Rock beneath the road is physical and uses the same top envelope. It never
// fills a river, bridge gap or lift shaft, and introduces no new shortcut top.
for(const map of Object.values(TYAGA_MAPS)){
  if(map.id!=='tutorial'){
    const p=add(map.finish.position,V(0,0,map.finish.size.z/2+2));
    map.surfaces.push({id:'station-foundation',position:add(p,V(0,-.5,0)),size:V(5,1,4.2),rotation:Q(),material:'stone',kind:'pad'});
    map.surfaces.push({id:'delivery-station',position:add(p,V(0,1.15,0)),size:V(3.6,2.3,2.5),rotation:Q(),material:'wood',kind:'rock',renderModel:'station',renderPosition:p});
  }
  for(const camp of map.checkpoints){
    const p=add(camp.position,V(0,0,camp.size.z/2+1.8));
    map.surfaces.push({id:`camp-pad-${camp.id}`,position:add(p,V(0,-.5,0)),size:V(4,1,4),rotation:Q(),material:'soil',kind:'pad'});
    for(const x of [-.6,.6])map.surfaces.push({id:`camp-post-${camp.id}-${x}`,position:add(p,V(x,.65,0)),size:V(.12,1.3,.12),rotation:Q(),material:'wood',kind:'frame'});
    map.surfaces.push({id:`camp-board-${camp.id}`,position:add(p,V(0,1.13,0)),size:V(1.5,.65,.12),rotation:Q(),material:'wood',kind:'frame',renderModel:'camp',renderPosition:p});
    for(const x of [-.9,.9])map.surfaces.push({id:`camp-box-${camp.id}-${x}`,position:add(p,V(x,.22,-.45)),size:V(.55,.44,.55),rotation:Q(),material:'wood',kind:'frame'});
  }
  const terrain=map.surfaces.filter(s=>!s.mesh&&['road','pad','pillar'].includes(s.kind)&&!['steel','wood'].includes(s.material));
  for(const surface of terrain){
    const depth=Math.max(2,surface.position.y-map.abyssY+3);
    map.surfaces.push({id:`bedrock-${surface.id}`,position:add(surface.position,rotate(surface.rotation,V(0,-surface.size.y/2-depth/2,0))),rotation:surface.rotation,size:V(surface.size.x,depth,surface.size.z),material:'stone',kind:'rock'});
  }
}
export const MAPS = TYAGA_MAPS;
export function getMap(id: MapId): TyagaMap { const m=TYAGA_MAPS[id];if(!m)throw new Error('UNKNOWN_MAP');return m; }
export function validateMap(map: TyagaMap): string[] {
  const errors:string[]=[];const ids=new Set<string>();
  for(const object of [...map.surfaces,...map.anchors,...map.startBodies,...map.checkpoints,map.finish]) {
    if(ids.has(object.id))errors.push(`Duplicate id: ${object.id}`);ids.add(object.id);
    const p=object.position;if(![p.x,p.y,p.z].every(Number.isFinite))errors.push(`Invalid coordinates: ${object.id}`);
    if(p.x< -1||p.x>map.bounds.x+1||p.z< -1||p.z>map.bounds.z+1)errors.push(`Outside map: ${object.id}`);
  }
  for(const checkpoint of map.checkpoints)if(checkpoint.size.x<14||checkpoint.size.z<14)errors.push(`Small checkpoint: ${checkpoint.id}`);
  const graphIds=new Set(map.roadGraph.nodes.map(n=>n.id));
  for(const edge of map.roadGraph.edges)if(!graphIds.has(edge.from)||!graphIds.has(edge.to))errors.push(`Unknown graph edge: ${edge.from}/${edge.to}`);
  for(const bridge of map.bridges)for(let i=1;i<bridge.centers.length;i++)if(Math.abs(bridge.centers[i].x-bridge.centers[i-1].x-bridge.length)>.001)errors.push(`Overlapping bridge sections: ${bridge.id}`);
  return errors;
}
