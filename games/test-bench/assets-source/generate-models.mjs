/**
 * Test Bench original parametric production geometry, Y-up, metres, +Z forward.
 * Run from the repository root. Every exported GLB is generated here; no mesh imports.
 * Articulated nodes and named empty connectors are preserved. Static detail is batched.
 */
import * as T from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mkdir, writeFile } from 'node:fs/promises';

globalThis.FileReader = class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then(value => { this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`; this.onloadend?.(); }); }
};
const root = new URL('../public/test-bench/models/', import.meta.url);
await mkdir(root, { recursive: true });
const palette = {
  amber: 0, ivory: 1, graphite: 2, rubber: 3,
  mint: 4, coral: 5, steel: 6, blue: 7,
  concrete: 8, darkConcrete: 9, wood: 10, black: 11,
  white: 12, green: 13, copper: 14, glass: 15,
};
const mats = {
  paint: new T.MeshStandardMaterial({name:'workshop-palette-enamel',color:0xffffff,metalness:.20,roughness:.64}),
  chassis: new T.MeshStandardMaterial({name:'test-bench-chassis-paint',color:0xefae48,metalness:.20,roughness:.64}),
  metal: new T.MeshStandardMaterial({name:'workshop-palette-metal',color:0xffffff,metalness:.62,roughness:.36}),
  rubber: new T.MeshStandardMaterial({name:'workshop-palette-rubber',color:0xffffff,metalness:0,roughness:.93}),
};
const connector = (group, name, x, y, z) => {
  const point = new T.Object3D(); point.name = name; point.position.set(x, y, z); point.userData.connector = true; group.add(point); return point;
};
const group = name => { const g = new T.Group(); g.name = name; return g; };
function mesh(g, geo, color, x=0, y=0, z=0, kind='paint', name='detail') {
  const uv=geo.getAttribute('uv');
  const cell=palette[color] ?? palette.ivory;
  if (uv) for(let i=0;i<uv.count;i++) {
    uv.setXY(i,((cell%4)+.18+uv.getX(i)*.64)/4, (Math.floor(cell/4)+.18+uv.getY(i)*.64)/4);
  }
  const m=new T.Mesh(geo,mats[kind]); m.name=name; m.position.set(x,y,z); g.add(m); return m;
}
function box(g,w,h,d,x,y,z,color='ivory',radius=.025,kind='paint') {
  return mesh(g,radius>0?new RoundedBoxGeometry(w,h,d,1,Math.min(radius,w/4,h/4,d/4)):new T.BoxGeometry(w,h,d),color,x,y,z,kind);
}
function cyl(g,r,h,x,y,z,color='steel',kind='metal',sides=16,r2=r) {
  return mesh(g,new T.CylinderGeometry(r,r2,h,sides),color,x,y,z,kind);
}
function rod(g,a,b,r,color='steel',kind='metal',sides=8) {
  const v=new T.Vector3(...b).sub(new T.Vector3(...a));
  const m=cyl(g,r,v.length(),(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2,color,kind,sides);
  m.quaternion.setFromUnitVectors(new T.Vector3(0,1,0),v.normalize()); return m;
}
function ring(g,r,t,x,y,z,color='steel',rx=Math.PI/2) {
  const m=mesh(g,new T.TorusGeometry(r,t,5,24),color,x,y,z,'metal'); m.rotation.x=rx; return m;
}
function spring(g,x,y,z,r=.07,h=.28,turns=4) {
  const p=[];for(let i=0;i<=turns*20;i++){const a=i/(turns*20);p.push(new T.Vector3(x+Math.cos(a*Math.PI*2*turns)*r,y+a*h,z+Math.sin(a*Math.PI*2*turns)*r));}
  return mesh(g,new T.TubeGeometry(new T.CatmullRomCurve3(p),turns*14,.018,5,false),'steel',0,0,0,'metal');
}
function bolt(g,x,y,z,r=.028) {cyl(g,r,.026,x,y,z,'steel','metal',6);box(g,.028,.004,.006,x,y+.015,z,'graphite',0);}
function socket(g,x,y,z) {cyl(g,.075,.018,x,y,z,'graphite');ring(g,.051,.009,x,y+.014,z,'steel');}
function striped(g,w,d,y,z,color='amber') {
  box(g,w,.015,d,0,y,z,color,.002);
  const count=Math.ceil(w/.22);for(let i=0;i<count;i++){const x=-w/2+(i+.5)*w/count;box(g,w/count*.48,.004,d,x,y+.009,z,'graphite',0);}
}
function chassis() {
  const g=group('chassis');
  box(g,1.28,.18,1.85,0,0,0,'white',.075,'chassis');
  box(g,1.06,.09,1.60,0,-.12,0,'graphite',.035);
  box(g,.96,.12,.34,0,.08,.93,'ivory',.06);
  box(g,.90,.10,.18,0,.025,-1.02,'graphite',.035);
  for(const side of [-1,1]){
    box(g,.08,.10,1.62,side*.59,.13,0,'ivory',.025);
    box(g,.065,.045,.58,side*.64,.04,.1,'graphite',.012);
    for(const z of [-.72,.72]){socket(g,side*.42,.104,z);bolt(g,side*.55,.105,z);}
    box(g,.12,.028,.24,side*.32,.151,.92,'mint',.015);
  }
  for(let i=0;i<5;i++)box(g,.065,.012,.22,(i-2)*.10,.154,.66,'graphite',.005);
  box(g,.35,.018,.23,0,.103,-.76,'ivory',.005);
  box(g,.22,.004,.014,0,.114,-.73,'graphite',0);
  for(let i=0;i<4;i++)box(g,.015,.004,.06,(i-1.5)*.045,.114,-.81,'graphite',0);
  connector(g,'socket-front',0,-.03,.8);connector(g,'socket-rear',0,-.03,-.8);
  connector(g,'socket-motor',0,.13,.59);connector(g,'socket-battery',0,.13,-.67);
  connector(g,'socket-cargo',0,.10,-.12);connector(g,'socket-aux-left',-.55,-.055,0);connector(g,'socket-aux-right',.55,-.055,0);
  connector(g,'nose',0,.1,1.1);g.userData.collision={type:'cuboid',halfExtents:[.62,.1,.98]};return g;
}
function axle(kind) {
  const r={road:.23,offroad:.27,high:.32}[kind]; const g=group(`axle-${kind}`);
  rod(g,[-.80,.04,0],[.80,.04,0],.045,'steel');
  box(g,.28,.11,.14,0,.04,0,'graphite');
  for(const side of [-1,1]){
    const steering=group(side<0?'wheel-left-steer':'wheel-right-steer');steering.position.set(side*.8,-.13,0);g.add(steering);
    const spin=group('wheel-spin');steering.add(spin);
    const profile=[[0,-.10],[r*.72,-.10],[r*.94,-.075],[r,-.045],[r,.045],[r*.94,.075],[r*.72,.10],[0,.10]].map(([rr,yy])=>new T.Vector2(rr,yy));
    const tire=mesh(spin,new T.LatheGeometry(profile,20),'rubber',0,0,0,'rubber');tire.rotation.z=Math.PI/2;
    for(const s of [-1,1]){
      const hub=cyl(spin,r*.56,.026,s*.104,0,0,kind==='high'?'coral':'ivory');hub.rotation.z=Math.PI/2;
      const nut=cyl(spin,.047,.038,s*.126,0,0,'steel','metal',6);nut.rotation.z=Math.PI/2;
      for(let j=0;j<6;j++){const a=j*Math.PI/3;const spoke=box(spin,.012,r*.75,.035,s*.121,0,0,'graphite',.004);spoke.rotation.x=a;}
    }
    const treadCount=kind==='road'?14:18;
    for(let i=0;i<treadCount;i++){
      const a=i*Math.PI*2/treadCount;
      const tread=box(spin,kind==='road'?.15:.19,kind==='road'?.012:.024,r*.23,0,Math.cos(a)*(r+.001),Math.sin(a)*(r+.001),'rubber',.004,'rubber');tread.rotation.x=a;
    }
    const suspension=group(side<0?'suspension-left':'suspension-right');suspension.position.set(side*.54,-.10,0);g.add(suspension);spring(suspension,0,0,0,.05,.21);
    box(g,.12,.04,.16,side*.54,.14,0,'amber');
    connector(g,side<0?'contact-left':'contact-right',side*.8,-.13-r,0);
  }
  g.userData.wheelRadius=r;g.userData.suspensionTravel=.13;return g;
}
function motor(kind) {
  const g=group(`motor-${kind}`);const color={speed:'coral',torque:'blue',economy:'mint'}[kind];
  box(g,.42,.16,.31,0,.09,0,'graphite');
  const barrel=cyl(g,kind==='torque'?.145:.12,.34,0,.20,0,color,'paint',16);barrel.rotation.z=Math.PI/2;
  for(let i=0;i<6;i++){
    const fin=cyl(g,.15,.017,(i-2.5)*.047,.20,0,'steel');fin.rotation.z=Math.PI/2;
  }
  const cap=cyl(g,.106,.025,.19,.20,0,'graphite');cap.rotation.z=Math.PI/2;
  rod(g,[-.13,.27,0],[-.16,.30,.18],.014,'copper');rod(g,[.13,.27,0],[.16,.30,.18],.014,'coral');
  for(const x of [-.16,.16])bolt(g,x,.18,.105,.02);
  return g;
}
function battery(kind) {
  const g=group(`battery-${kind}`);const d=kind==='large'?.34:.23;
  box(g,.44,.21,d,0,.115,0,'graphite',.038);
  box(g,.31,.018,d*.66,0,.23,0,'mint',.008);
  for(let i=0;i<3;i++)box(g,.065,.005,d*.46,(i-1)*.087,.242,0,'ivory',.003);
  for(const s of [-1,1]){cyl(g,.035,.035,s*.12,.245,d*.43,'copper');box(g,.027,.004,.008,s*.12,.267,d*.43,'ivory',0);}
  box(g,.08,.005,.025,.17,.224,0,'coral',.005);return g;
}
function cargoModule(kind){
  const g=group(`cargo-${kind}`);
  box(g,1.20,.07,.65,0,.04,0,'graphite');
  const body=group('cargo-bed');g.add(body);body.position.y=kind==='cradle'?.16:.07;
  box(body,1.20,.05,.66,0,0,0,kind==='cradle'?'ivory':'amber',.025);
  for(const x of [-.42,0,.42]){
    cyl(body,.123,.024,x,.035,0,'rubber','rubber');ring(body,.13,.018,x,.059,0,'steel');
    connector(g,`cargo-${Math.round(x/.42)+1}`,x,.23+body.position.y,0);
  }
  for(const s of [-1,1]){
    box(body,.045,.12,.64,s*.60,.075,0,'ivory',.016);
    box(body,1.17,.12,.035,0,.075,s*.31,'ivory',.012);
  }
  if(kind==='cradle'){
    for(const x of [-.48,.48])for(const z of [-.22,.22])spring(g,x,.03,z,.045,.11,3);
    for(const s of [-1,1])box(body,.11,.03,.27,s*.62,.06,0,'mint',.012);
  }
  if(kind==='clamp'){
    for(const s of [-1,1]){
      const jaw=group(s<0?'clamp-left':'clamp-right');g.add(jaw);jaw.position.set(s*.57,.15,0);
      rod(jaw,[0,0,-.23],[0,.29,-.23],.028,'blue');rod(jaw,[0,0,.23],[0,.29,.23],.028,'blue');
      rod(jaw,[0,.29,-.25],[0,.29,.25],.043,'graphite');
    }
    box(g,.22,.08,.18,0,.08,.41,'blue');box(g,.13,.01,.08,0,.126,.41,'mint');
  }
  return g;
}
function aux(kind){
  const g=group(`aux-${kind}`);
  if(kind==='ballast'){
    box(g,.20,.16,.46,0,0,0,'steel',.025,'metal');box(g,.22,.025,.12,0,.08,0,'graphite');
    for(const z of [-.16,.16])bolt(g,0,.09,z,.025);
  }else if(kind==='damper'){
    rod(g,[0,-.1,0],[0,.34,0],.025,'steel');spring(g,0,-.06,0,.071,.31,5);
    for(const y of [-.11,.35]){cyl(g,.09,.04,0,y,0,'coral');}
  }else{
    rod(g,[-.43,.07,-.47],[-.43,.72,-.47],.047,'graphite');rod(g,[.43,.07,-.47],[.43,.72,-.47],.047,'graphite');
    rod(g,[-.43,.72,-.47],[.43,.72,-.47],.047,'graphite');
    rod(g,[-.43,.62,-.47],[-.43,.07,.12],.035,'graphite');rod(g,[.43,.62,-.47],[.43,.07,.12],.035,'graphite');
    box(g,.88,.055,.10,0,.73,-.47,'amber');
  }return g;
}
function cargo(kind,state){
  const g=group(`cargo-${kind}-${state}`);const damaged=state!=='whole',broken=state==='broken';
  if(kind==='egg'){
    const profile=[];for(let i=0;i<=12;i++){const t=i/12*Math.PI;profile.push(new T.Vector2(Math.sin(t)*(.115+.022*Math.cos(t)),.15*Math.cos(t)));}
    const shell=mesh(g,new T.LatheGeometry(profile,16),damaged?'coral':'ivory',0,broken?.04:.16,0);if(broken)shell.scale.y=.34;
    ring(g,.12,.018,0,.14,0,'steel');
    for(const x of [-.1,.1])rod(g,[x,.04,-.06],[x,.21,-.06],.012,'mint');
  }else if(kind==='block'){
    box(g,.28,broken?.08:.24,.24,0,broken?.05:.13,0,damaged?'coral':'blue',.035);
    box(g,.18,.014,.13,0,broken?.095:.257,0,'ivory',.005);
    for(let i=0;i<3;i++)box(g,.012,.008,.07,(i-1)*.045,broken?.105:.27,0,'graphite',0);
  }else{
    cyl(g,.115,broken?.10:.30,0,broken?.065:.16,0,damaged?'coral':'mint');
    for(const y of [broken?.035:.035,broken?.12:.29])cyl(g,.126,.035,0,y,0,'graphite');
    cyl(g,.05,.03,0,broken?.145:.32,0,'copper');
  }
  if(damaged){
    rod(g,[-.05,.23,.112],[.02,.16,.126],.009,'graphite','paint',4);rod(g,[.02,.16,.126],[-.04,.10,.12],.009,'graphite','paint',4);
  }
  if(broken){for(let i=0;i<5;i++){const a=i*2.4;const shard=box(g,.075,.025,.055,Math.cos(a)*.16,.025,Math.sin(a)*.16,i%2?'coral':'ivory',.005);shard.rotation.y=a;}}
  // The export origin is the rigid-body centre used by the authoritative snapshot.
  g.children.forEach(child=>{child.position.y-=.14;});
  g.userData.collision={type:kind==='block'?'cuboid':'capsule',radius:.12};return g;
}
function gate(){
  const g=group('gate');for(const s of [-1,1]){
    box(g,.30,.12,.44,s*1.12,.06,0,'graphite');
    box(g,.10,1.45,.12,s*1.12,.83,0,'amber',.02);
    for(let i=0;i<4;i++)box(g,.105,.13,.125,s*1.12,.32+i*.27,0,'ivory',.005);
    box(g,.37,.30,.045,s*1.12,1.56,0,'graphite',.025);
    const chevron=box(g,.18,.045,.05,s*1.12,1.56,.032,'ivory',.004);chevron.rotation.z=s*Math.PI/4;
  }
  striped(g,2.1,.25,.012,0);connector(g,'label',0,1.75,0);return g;
}
function prop(kind){
  const g=group(kind);
  if(kind==='edge'){
    box(g,.20,.22,1,0,.11,0,'ivory',.025);box(g,.22,.04,.48,0,.24,0,'amber',.01);
  }else if(kind==='barrier'){
    box(g,1,.33,.19,0,.165,0,'ivory',.035);for(let i=0;i<4;i++){const m=box(g,.10,.25,.01,(i-1.5)*.24,.17,.10,'coral',.005);m.rotation.z=.32;}
  }else if(kind==='rib'){
    const geometry=new T.BufferGeometry();
    const v=[-.5,0,-.18,-.5,.10,0,.5,0,-.18,.5,0,-.18,-.5,.10,0,.5,.10,0,-.5,.10,0,-.5,0,.18,.5,.10,0,.5,.10,0,-.5,0,.18,.5,0,.18];
    geometry.setAttribute('position',new T.Float32BufferAttribute(v,3));geometry.setAttribute('uv',new T.Float32BufferAttribute([0,0,0,.5,1,0,1,0,0,.5,1,.5,0,.5,0,1,1,.5,1,.5,0,1,1,1],2));geometry.computeVertexNormals();mesh(g,geometry,'darkConcrete');
    box(g,.94,.003,.018,0,.102,0,'amber',0);
  }else if(kind==='ramp'){
    const geometry=new T.BufferGeometry();const vertices=[-.5,0,-.5,.5,1,.5,.5,0,-.5,-.5,0,-.5,-.5,1,.5,.5,1,.5];geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3));geometry.setAttribute('uv',new T.Float32BufferAttribute([0,0,1,1,1,0,0,0,0,1,1,1],2));geometry.computeVertexNormals();mesh(g,geometry,'concrete');
  }else if(kind==='puddle'){
    box(g,1,.008,1,0,.004,0,'blue',0);
    for(let i=0;i<4;i++){const m=ring(g,.08+i*.075,.005,0,.011,0,'glass');m.scale.set(.65,1,1);}
  }else if(kind==='start-light'){
    cyl(g,.30,.08,0,.04,0,'graphite');cyl(g,.045,1.55,0,.80,0,'steel');box(g,.36,.72,.20,0,1.60,0,'graphite',.035);
    for(let i=0;i<3;i++){const m=cyl(g,.075,.025,0,1.37+i*.22,.12,['mint','amber','coral'][i]);m.rotation.x=Math.PI/2;}
  }else if(kind==='loading-dock'){
    box(g,1.35,.12,.80,0,.06,0,'ivory',.06);striped(g,1.32,.16,.13,.3);
    for(const x of [-.43,0,.43]){cyl(g,.14,.08,x,.16,0,'graphite');ring(g,.14,.012,x,.21,0,'mint');}
    box(g,.08,1.25,.08,-.70,.68,0,'steel');box(g,.50,.35,.07,-.70,1.35,0,'mint',.025);connector(g,'label',-.70,1.37,.05);
  }else if(kind==='unload-pad'){
    box(g,3.6,.028,3.0,0,.014,0,'mint',.03);for(const s of [-1,1])box(g,.09,.015,2.8,s*1.65,.035,0,'ivory',.005);
    for(let i=0;i<7;i++)box(g,.23,.015,.20,(i-3)*.45,.035,-1.3,i%2?'graphite':'ivory',.002);
    connector(g,'label',0,.05,0);
  }else if(kind==='workbench'){
    box(g,2.4,.16,1.05,0,1.05,0,'wood',.045);for(const x of [-.96,.96])for(const z of [-.35,.35])box(g,.10,.98,.10,x,.49,z,'graphite');
    box(g,1.9,.10,.65,0,.35,0,'steel');box(g,.62,.30,.56,.6,.82,0,'blue');
  }else if(kind==='drawer-cabinet'){
    box(g,1.25,1.0,.65,0,.50,0,'blue',.055);for(let i=0;i<3;i++){box(g,1.12,.25,.035,0,.19+i*.30,.34,'ivory',.015);box(g,.32,.035,.045,0,.25+i*.30,.38,'graphite');}
    box(g,1.34,.06,.73,0,1.04,0,'wood');
  }else if(kind==='lamp'){
    cyl(g,.34,.08,0,.04,0,'graphite');cyl(g,.035,2.7,0,1.40,0,'steel');rod(g,[0,2.72,0],[.60,2.95,0],.045,'graphite');
    cyl(g,.16,.24,.60,2.86,0,'amber','paint',12,.30);cyl(g,.27,.012,.60,2.737,0,'ivory');
  }else if(kind==='toolbox'){
    box(g,.70,.38,.38,0,.20,0,'coral',.045);box(g,.72,.06,.40,0,.41,0,'coral');
    rod(g,[-.16,.45,0],[-.16,.58,0],.023,'graphite');rod(g,[-.16,.58,0],[.16,.58,0],.023,'graphite');rod(g,[.16,.58,0],[.16,.45,0],.023,'graphite');
    for(const x of [-.22,.22])box(g,.06,.11,.025,x,.34,.22,'steel',.008,'metal');
  }else if(kind==='stool'){
    cyl(g,.34,.09,0,.66,0,'amber');for(let i=0;i<3;i++){const a=i*Math.PI*2/3;rod(g,[Math.cos(a)*.25,.62,Math.sin(a)*.25],[Math.cos(a)*.34,.03,Math.sin(a)*.34],.035,'steel');}ring(g,.25,.015,0,.28,0,'steel');
  }else if(kind==='crate'){
    box(g,.64,.60,.64,0,.30,0,'wood',.025);for(const s of [-1,1])for(const y of [.10,.49])box(g,.70,.10,.06,0,y,s*.33,'darkConcrete',.01);box(g,.25,.005,.25,0,.605,0,'ivory',.005);
  }else if(kind==='pegboard'){
    box(g,1.75,1.15,.08,0,1.65,0,'wood',.035);for(let i=0;i<7;i++)for(let j=0;j<4;j++)box(g,.025,.025,.008,(i-3)*.23,1.28+j*.23,.048,'graphite',0);
    for(let i=0;i<4;i++){rod(g,[-.55+i*.35,1.35,.08],[-.55+i*.35,1.88,.08],.027,'steel');box(g,.09,.16,.08,-.55+i*.35,1.32,.09,'coral');}
  }else if(kind==='cable-spool'){
    cyl(g,.29,.54,0,.33,0,'graphite');for(const y of [.06,.62])cyl(g,.37,.07,0,y,0,'wood');for(let i=0;i<7;i++)ring(g,.29,.018,0,.15+i*.06,0,'copper');
  }else if(kind==='fire-extinguisher'){
    cyl(g,.13,.55,0,.35,0,'coral');cyl(g,.06,.12,0,.68,0,'steel');box(g,.21,.05,.09,0,.78,0,'graphite');rod(g,[.07,.70,0],[.20,.55,0],.025,'rubber','rubber');box(g,.18,.23,.012,0,.38,.135,'ivory');
  }else if(kind==='plant'){
    cyl(g,.24,.32,0,.16,0,'ivory','paint',12,.18);cyl(g,.21,.01,0,.33,0,'darkConcrete');
    for(let i=0;i<7;i++){const a=i*2.4;const p=[Math.cos(a)*.24,.52+(i%3)*.13,Math.sin(a)*.24];rod(g,[0,.33,0],p,.018,'green','paint');const m=mesh(g,new T.SphereGeometry(.12,8,5),'green',...p);m.scale.set(.8,2,.35);m.rotation.z=a;}
  }
  return g;
}
function batch(node) {
  node.children.filter(c=>!c.isMesh).forEach(batch);
  const meshes=node.children.filter(c=>c.isMesh);const buckets=new Map();
  for(const m of meshes){m.updateMatrix();const geo=m.geometry.clone();geo.applyMatrix4(m.matrix);const non=geo.index?geo.toNonIndexed():geo;const key=m.material.name;if(!buckets.has(key))buckets.set(key,{material:m.material,geometries:[]});buckets.get(key).geometries.push(non);node.remove(m);}
  for(const {material,geometries} of buckets.values()){
    const merged=mergeVertices(mergeGeometries(geometries,false),.00001);const m=new T.Mesh(merged,material);m.name=node.name+'-surface';node.add(m);
  }
}
function injectAtlas(data){
  const view=new DataView(data),len=view.getUint32(12,true);const json=JSON.parse(new TextDecoder().decode(new Uint8Array(data,20,len)).trim());
  json.images=[{uri:'../textures/workshop-palette.png',name:'Original workshop enamel atlas'}];
  json.samplers=[{magFilter:9729,minFilter:9729,wrapS:33071,wrapT:33071}];json.textures=[{sampler:0,source:0}];
  for(const m of json.materials)m.pbrMetallicRoughness.baseColorTexture={index:0};
  const j=Buffer.from(JSON.stringify(json));const padded=Buffer.concat([j,Buffer.alloc((4-j.length%4)%4,32)]);
  const binary=Buffer.from(data,20+len);const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(20+padded.length+binary.length,8);header.writeUInt32LE(padded.length,12);header.writeUInt32LE(0x4e4f534a,16);return Buffer.concat([header,padded,binary]);
}
const models=[['chassis',chassis()]];
for(const k of ['road','offroad','high'])models.push([`axle-${k}`,axle(k)]);
for(const k of ['speed','torque','economy'])models.push([`motor-${k}`,motor(k)]);
for(const k of ['small','large'])models.push([`battery-${k}`,battery(k)]);
for(const k of ['platform','cradle','clamp'])models.push([`cargo-${k}`,cargoModule(k)]);
for(const k of ['damper','ballast','rollbar'])models.push([`aux-${k}`,aux(k)]);
for(const k of ['egg','block','cell'])for(const s of ['whole','damaged','broken'])models.push([`cargo-${k}-${s}`,cargo(k,s)]);
models.push(['gate',gate()]);
for(const k of ['edge','barrier','rib','ramp','puddle','start-light','loading-dock','unload-pad','workbench','drawer-cabinet','lamp','toolbox','stool','crate','pegboard','cable-spool','fire-extinguisher','plant'])models.push([k,prop(k)]);
const inventory=[];
for(const [id,model] of models){
  model.userData={...model.userData,author:'Iva Games original procedural asset',license:'MIT',units:'metres',up:'Y',forward:'Z'};
  batch(model);model.updateMatrixWorld(true);const bounds=new T.Box3().setFromObject(model);const size=bounds.getSize(new T.Vector3());
  let triangles=0,draws=0;model.traverse(o=>{if(o.isMesh){draws++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;}});
  const data=await new GLTFExporter().parseAsync(model,{binary:true,onlyVisible:true});const glb=injectAtlas(data);await writeFile(new URL(id+'.glb',root),glb);
  inventory.push({id,bytes:glb.length,triangles,drawCalls:draws,dimensionsM:size.toArray(),connectors:model.children.filter(c=>c.userData.connector).map(c=>({name:c.name,position:c.position.toArray()}))});
}
await writeFile(new URL('../model-inventory.json',root),JSON.stringify(inventory,null,2)+'\n');
console.log(`Generated ${inventory.length} original GLBs; ${inventory.reduce((sum,m)=>sum+m.bytes,0)} bytes; ${inventory.reduce((sum,m)=>sum+m.triangles,0)} triangles.`);
