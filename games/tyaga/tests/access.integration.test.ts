import { expect, it } from 'vitest';
import { TyagaWorld } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { clamp, distance, V } from '../src/core/math';
import type { TyagaInput } from '../src/core/types';
import { evidence } from './evidence';

// An ordinary service route from the authored spawn. This does not move the
// truck, deliver cargo or replace any browser acceptance scenario.
const carryDrive=process.env.TYAGA_ACCESS_EMPTY!=='1';
it.runIf(process.env.TYAGA_ACCESS==='1')(`Ridge: a person reaches the lift and climbs its real stairs${carryDrive?' with the drive':''}`,async()=>{
 const w=await TyagaWorld.create({matchId:'ridge-lift-service-route',mapId:'ridge',mode:'practice',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'helper',displayName:'Helper',seatIndex:1,bot:true}]});
 const trace:unknown[]=[];let completed=false;
 const view=()=>w.view('human'),actor=()=>view().entities.find(e=>e.id==='person:human')!;
 const step=(n:number,input:Partial<TyagaInput>={})=>{for(let i=0;i<n;i++)w.step({human:{...NEUTRAL_INPUT,...input}});};
 const record=(stage:string)=>{const v=view();trace.push({stage,tick:v.tick,actor:actor(),participant:v.participants.find(p=>p.participantId==='human'),drive:v.entities.find(e=>e.id==='lift-drive'),events:v.events.slice(-8)});};
 const walk=(x:number,z:number,jumpOnStairs=false)=>{
  const start={...actor().position},pathX=x-start.x,pathZ=z-start.z,pathLength=Math.hypot(pathX,pathZ);
  for(let i=0;i<3000;i++){
   const p=actor().position,dx=x-p.x,dz=z-p.z,d=Math.hypot(dx,dz);
   if(d<.06){step(15);record(`walk-${x}-${z}`);return;}
   if(i%60===0)trace.push({stage:'walking',tick:view().tick,target:{x,z},position:{...p},velocity:actor().velocity});
   if(jumpOnStairs&&i%45===20){const result=w.action('human',{type:'jump'});trace.push({stage:'stair-jump',tick:view().tick,result:result.result});}
   const projection=((p.x-start.x)*pathX+(p.z-start.z)*pathZ)/(pathLength*pathLength),ahead=clamp(projection+1/pathLength,0,1),aimX=start.x+pathX*ahead-p.x,aimZ=start.z+pathZ*ahead-p.z,aimDistance=Math.hypot(aimX,aimZ);
   const speed=clamp(d/.5,0,1);step(1,{moveX:aimX/aimDistance*speed,moveZ:aimZ/aimDistance*speed});
   if(view().participants.find(p=>p.participantId==='human')?.rescueIn!==undefined)throw new Error('ROUTE_FALL');
  }record('blocked');throw new Error(`WALK_BLOCKED:${x},${z}:${JSON.stringify(actor().position)}`);
 };
 try{
  for(const [x,z]of [[20,54],[24,52],[30,52],[44,52],[64,52],[92,52],[113,52],[113,56.3],[129,56.3],[129,52],[164,52],[192,52],[202,72],[210,72],[210,68]])walk(x,z);
  if(carryDrive){const drive=view().entities.find(e=>e.id==='lift-drive')!,handle=drive.sockets.find(s=>s.id==='handle-0')!;
   walk(210,70);walk(drive.position.x+1.4,70);walk(drive.position.x+1.4,handle.world.z);
   expect(w.action('human',{type:'grab',itemId:'lift-drive',handleId:'handle-0'}).result.ok).toBe(true);step(120,{tool:1});}
  walk(209.8,70);walk(209.8,67);walk(217.7,67,process.env.TYAGA_ACCESS_JUMP==='1');walk(222,67);walk(222,68.8);
  record('at-transmission');expect(actor().position.y).toBeGreaterThan(16.7);expect(view().participants.find(p=>p.participantId==='human')?.holding).toBe(carryDrive?'lift-drive':null);
  const control=view().entities.find(e=>e.id==='lift-transmission')!;expect(distance(control.position,V(222,17.25,69.3))).toBeLessThan(.0001);completed=true;
 }finally{record('final');evidence(`ridge-lift-service-ordinary-inputs${carryDrive?'':'-empty'}`,{kind:'fresh authored ridge; only normal public inputs/actions; technical access, not a delivery or browser acceptance',completed,trace},'ordinary public controls from authored map spawn; not browser acceptance');w.dispose();}
},120000);
