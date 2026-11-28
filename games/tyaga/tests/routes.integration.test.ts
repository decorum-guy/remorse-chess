import { expect, it } from 'vitest';
import { TyagaWorld } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { angleDifference, clamp, distance, V, yaw } from '../src/core/math';
import type { TyagaAction, TyagaInput, Vec3 } from '../src/core/types';
import { evidence } from './evidence';

// Technical traversal through the public game controls. It does not replace
// browser acceptance. No body pose/velocity, inventory, phase or outcome writes.
const mapId=process.env.TYAGA_ROUTE_MAP==='quarry'?'quarry':'valley';
const routeId=mapId==='valley'?'valley-v2':'quarry-low';
it.runIf(process.env.TYAGA_ROUTES==='1')(`${routeId}: fresh room to delivery through the authored roads`,async()=>{
 const w=await TyagaWorld.create({matchId:`${routeId}-ordinary-route`,mapId,mode:'expedition',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'helper',displayName:'Helper',seatIndex:1,bot:true}]});
 const trace:unknown[]=[];let completed=false;
 const view=()=>w.view('human');
 const actor=()=>view().entities.find(e=>e.id==='person:human')!;
 const step=(n:number,input:Partial<TyagaInput>={})=>{for(let i=0;i<n;i++)w.step({human:{...NEUTRAL_INPUT,...input}});};
 const action=(a:TyagaAction)=>{const result=w.action('human',a);trace.push({tick:view().tick,action:a,result:result.result});expect(result.result.ok,JSON.stringify(result.result)).toBe(true);return result;};
 const record=(stage:string)=>{const v=view();const contacts:unknown[]=[];for(const handle of w.state.entities.truck.colliders){const collider=w.physics.getCollider(handle);w.physics.contactPairsWith(collider,other=>{w.physics.contactPair(collider,other,m=>{if(m.numSolverContacts())contacts.push({collider:handle,other:w.state.colliderBodies[other.handle],normal:{...m.normal()},count:m.numSolverContacts()});});});}trace.push({stage,tick:v.tick,truck:v.entities.find(e=>e.id==='truck'),driver:v.truck,cargo:v.entities.filter(e=>e.required),crew:v.participants.map(p=>({participant:p,body:v.entities.find(e=>e.id===p.entityId)})),checkpoint:v.checkpoint,finish:v.finishReason,contacts,events:v.events.slice(-8)});};
 const walk=(target:Vec3)=>{
  for(let i=0;i<600;i++){
   const p=actor().position,dx=target.x-p.x,dz=target.z-p.z,d=Math.hypot(dx,dz);if(d<.08){step(15);return;}
   step(1,{moveX:dx/d*clamp(d/.5,0,1),moveZ:dz/d*clamp(d/.5,0,1)});
  }throw new Error(`WALK_BLOCKED:${JSON.stringify(actor().position)}`);
 };
 const enter=()=>{const truck=view().entities.find(e=>e.id==='truck')!;const socket=truck.sockets.find(s=>s.id==='cab-right')!;const q=yaw(truck.rotation);walk(V(socket.world.x+Math.sin(q)*.8,0,socket.world.z+Math.cos(q)*.8));action({type:'operate',targetId:'truck'});action({type:'brake',enabled:false});};
 const drive=(corners:Vec3[])=>{
  const points=[corners[0]];
  for(let i=1;i<corners.length-1;i++){
   const a=corners[i-1],c=corners[i],b=corners[i+1],li=Math.hypot(c.x-a.x,c.z-a.z),lo=Math.hypot(b.x-c.x,b.z-c.z),ux=(c.x-a.x)/li,uz=(c.z-a.z)/li,vx=(b.x-c.x)/lo,vz=(b.z-c.z)/lo;
   const turn=Math.acos(clamp(ux*vx+uz*vz,-1,1));if(turn<.08){points.push(c);continue;}
   const sign=Math.sign(ux*vz-uz*vx),cut=Math.min(6.5*Math.tan(turn/2),li*.85,lo*.85),radius=cut/Math.tan(turn/2);
   const start=V(c.x-ux*cut,c.y-(c.y-a.y)*cut/li,c.z-uz*cut),end=V(c.x+vx*cut,c.y+(b.y-c.y)*cut/lo,c.z+vz*cut),center=V(start.x-uz*radius*sign,0,start.z+ux*radius*sign),angle=Math.atan2(start.z-center.z,start.x-center.x),steps=Math.ceil(turn*radius);
   for(let n=0;n<=steps;n++){const t=n/steps,theta=angle+turn*sign*t;points.push(V(center.x+Math.cos(theta)*radius,start.y+(end.y-start.y)*t,center.z+Math.sin(theta)*radius));}
  }
  points.push(corners.at(-1)!);
  let segment=0,stationaryFor=0;let previous=view().entities.find(e=>e.id==='truck')!.position;
  for(let frame=0;frame<2400;frame++){
   const v=view(),truck=v.entities.find(e=>e.id==='truck')!,p=truck.position;
   if(v.phase!=='running')throw new Error(`MISSION_${v.phase}`);
   const goal=points.at(-1)!,remaining=Math.hypot(goal.x-p.x,goal.z-p.z);
   if(segment===points.length-2&&remaining<.7&&Math.abs(v.truck.speed)<.2){step(90,{brake:true});record('arrived');return;}
   let a=points[segment],b=points[segment+1],dx=b.x-a.x,dz=b.z-a.z,len=Math.hypot(dx,dz);
   let projection=((p.x-a.x)*dx+(p.z-a.z)*dz)/(len*len);
   while(segment<points.length-2&&(projection>.95||Math.hypot(b.x-p.x,b.z-p.z)<1.6)){
    segment++;a=points[segment];b=points[segment+1];dx=b.x-a.x;dz=b.z-a.z;len=Math.hypot(dx,dz);projection=((p.x-a.x)*dx+(p.z-a.z)*dz)/(len*len);
   }
   let look=2.5,offset=clamp(projection,0,1)*len,index=segment;
   while(index<points.length-2&&offset+look>len){look-=len-offset;index++;offset=0;a=points[index];b=points[index+1];dx=b.x-a.x;dz=b.z-a.z;len=Math.hypot(dx,dz);}
   const t=clamp((offset+look)/len,0,1),target=V(a.x+dx*t,a.y+(b.y-a.y)*t,a.z+dz*t);
   const heading=-Math.atan2(target.z-p.z,target.x-p.x),error=angleDifference(heading,yaw(truck.rotation));
   const targetDistance=Math.hypot(target.x-p.x,target.z-p.z),steer=clamp(Math.atan2(7.2*Math.sin(error),targetDistance)/(32*Math.PI/180),-1,1);let desiredSpeed=Math.abs(steer)>.3?.7:Math.abs(steer)>.15?1.2:2.3;
   if(segment===points.length-2)desiredSpeed=Math.min(desiredSpeed,remaining*.7);
   const brake=v.truck.speed>desiredSpeed+.25||remaining<.7&&segment===points.length-2;
   const throttle=brake?0:clamp((desiredSpeed-v.truck.speed)*1.4+.08,0,1);
   step(6,{throttle,steer,brake});
   stationaryFor=distance(previous,p)<.007?stationaryFor+.1:0;previous={...p};
   if(frame%10===0)trace.push({stage:'driving',tick:v.tick,segment,position:p,heading:yaw(truck.rotation),target,error,steer,throttle,brake,speed:v.truck.speed,integrity:v.truck.integrity,wheels:v.truck.wheels.map(x=>x.grounded)});
   if(stationaryFor>8){record('stalled');throw new Error(`DRIVE_STALLED:${segment}:${JSON.stringify(p)}`);}
  }record('drive-timeout');throw new Error('DRIVE_TIMEOUT');
 };
 const camp=(id:string)=>{
  action({type:'release'});
  for(let i=0;i<1200&&!view().checkpoint.ready;i++)step(1);
  record(`camp-${id}`);action({type:'checkpoint',checkpointId:id});
 };
 try{
  record('fresh');enter();
  const paths=mapId==='valley'?[
   [[12,0,32],[32,0,32],[36,-.2,50],[61.5,-.2,51],[64.7,-.1,43],[68,0,32],[76,0,32]],
   [[76,0,32],[90,0,32],[90,0,16],[122,6,16],[126,6,32],[132,6,32]],
   [[132,6,32],[140,6,32],[147,6,43],[156,6,43],[161,6,32],[168,6,32]],
  ]:[
   [[12,0,48],[30,0,48],[45,-4,48],[72,-4,48],[90,0,48],[100,0,48]],
   [[100,0,48],[120,0,48],[146,4,48],[162,4,48]],
   [[162,4,48],[178,4,48],[183,4,58],[194,4,58],[199,4,48],[210,4,48]],
  ];
  for(let i=0;i<paths.length;i++){drive(paths[i].map(p=>V(...p as [number,number,number])));if(i<2){camp(`${mapId}-cp${i+1}`);enter();}}
  action({type:'release'});
  for(let i=0;i<1800&&!view().finishReady;i++)step(1);
  record('at-finish');action({type:'finish'});completed=view().outcome!==null;expect(completed).toBe(true);
 }finally{record('final');evidence(`${routeId}-ordinary-route`,{kind:'fresh authored map; only public inputs/actions; technical traversal, not browser acceptance',completed,trace},'ordinary public controls from authored map spawn; not browser acceptance');w.dispose();}
},120000);
