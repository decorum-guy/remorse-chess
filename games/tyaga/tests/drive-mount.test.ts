import { expect, it } from 'vitest';
import { TyagaWorld } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { clamp, distance, yaw } from '../src/core/math';
import { evidence } from './evidence';
import RAPIER from '@dimforge/rapier3d-compat';

// This route starts from the authored map. All body movement below is caused
// by ordinary input/actions; there are no fixture poses or transform writes.
it('a person carries and lowers the actual quarry drive into its canonical ferry mount',async()=>{
 const w=await TyagaWorld.create({matchId:'ferry-mount-ordinary-route',mapId:'quarry',mode:'practice',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'helper',displayName:'Helper',seatIndex:1,bot:true}]});
 const trace:unknown[]=[];
 const view=()=>w.view('human');
 const actor=()=>view().entities.find(e=>e.id==='person:human')!;
 const record=(stage:string)=>trace.push({stage,tick:view().tick,actor:actor().position,drive:view().entities.find(e=>e.id==='ferry-drive'),holding:view().participants.find(p=>p.participantId==='human'),operations:view().operations,events:view().events.slice(-5)});
 const step=(n:number,tool=0)=>{for(let i=0;i<n;i++)w.step({human:{...NEUTRAL_INPUT,tool}});};
 const walk=(x:number,z:number)=>{
  let reached=false;
  for(let i=0;i<2400;i++){
   const p=actor().position,dx=x-p.x,dz=z-p.z,d=Math.hypot(dx,dz);
   if(d<.045){reached=true;break;}
   if(i%60===0)trace.push({stage:'walking',target:{x,z},i,actor:actor().position,velocity:actor().velocity,animation:actor().animation});
   if(view().participants.find(p=>p.participantId==='human')?.rescueIn!==undefined)throw new Error('FELL_FROM_ROUTE');
   const speed=clamp(d/.5,0,1);w.step({human:{...NEUTRAL_INPUT,moveX:dx/d*speed,moveZ:dz/d*speed}});
  }
  if(!reached){const p=actor().position,dx=x-p.x,dz=z-p.z,d=Math.hypot(dx,dz),hit=w.physics.castRay(new RAPIER.Ray({x:p.x,y:p.y-.86,z:p.z},{x:dx/d,y:0,z:dz/d}),.5,true,undefined,undefined,undefined,w.body('person:human'));trace.push({stage:'walk-blockage',p,grounded:w.state.characters.human.grounded,lowHit:hit?{id:w.state.colliderBodies[hit.collider.handle],toi:hit.timeOfImpact}:null,force:w.body('person:human').userForce(),ground:w.ground({x:p.x,y:p.y-.65,z:p.z},.4,'person:human')?.point,ahead:w.ground({x:p.x+dx/d*.48,y:p.y,z:p.z+dz/d*.48},1.2,'person:human')?.point,ramp:view().entities.find(e=>e.id==='near-ramp')});}
  step(10);record(`walk-${x}-${z}`);if(!reached)throw new Error(`WALK_BLOCKED:${x},${z}:${JSON.stringify(actor().position)}`);
 };
 try{
  walk(17,50.2);walk(30,48);walk(34.5,61.5);
  const handle=view().entities.find(e=>e.id==='ferry-drive')!.sockets.find(s=>s.id==='handle-0')!;walk(handle.world.x-.75,handle.world.z+.6);record('at-drive');
  const grab=w.action('human',{type:'grab',itemId:'ferry-drive',handleId:'handle-0'});trace.push({stage:'grab',result:grab.result});expect(grab.result.ok).toBe(true);step(45,1);step(60);
  for(let i=0;i<6;i++){const heading=yaw(view().entities.find(e=>e.id==='ferry-drive')!.rotation);if(Math.abs(heading)<.14)break;expect(w.action('human',{type:'rotate',direction:heading>0?-1:1}).result.ok).toBe(true);step(120);}record('oriented');
  walk(34.8,61.5);walk(34.8,67);walk(37.5,66.6);
  for(let i=0;i<3;i++){const drive=view().entities.find(e=>e.id==='ferry-drive')!,deck=view().entities.find(e=>e.id==='ferry-deck')!,p=actor().position;walk(p.x+deck.position.x-4.85-drive.position.x,p.z+deck.position.z+2.5-drive.position.z);}
  let permitted=false;
  for(let i=0;i<600;i++){
   const item=view().interactions.find(a=>a.id==='install-drive-ferry-drive-ferry-deck');
   if(item?.enabled){permitted=true;break;}
   const drive=view().entities.find(e=>e.id==='ferry-drive')!,deck=view().entities.find(e=>e.id==='ferry-deck')!,own=drive.sockets.find(s=>s.id==='drive')!,target=deck.sockets.find(s=>s.id==='drive')!;
   if(i%30===0)trace.push({stage:'lowering',i,own:own.world,target:target.world,reason:item?.reason,actor:actor().position});
   const outside=drive.position.y>deck.position.y-.25;
   const dx=outside?deck.position.x-4.85-drive.position.x:target.world.x-own.world.x,dz=outside?deck.position.z+2.5-drive.position.z:target.world.z-own.world.z;
   w.step({human:{...NEUTRAL_INPUT,moveX:clamp(dx*.8,-.35,.35),moveZ:clamp(dz*.8,-.35,.35),tool:target.world.y<own.world.y-.08?-.5:0}});
   if(!view().participants.find(p=>p.participantId==='human')?.holding)break;
  }
  const contacts:unknown[]=[];for(const h of w.state.entities['ferry-drive'].colliders)w.physics.contactPairsWith(w.physics.getCollider(h),other=>{w.physics.contactPair(w.physics.getCollider(h),other,m=>{if(m.numSolverContacts())contacts.push({collider:h,other:w.state.colliderBodies[other.handle],normal:m.normal(),count:m.numSolverContacts()});});});trace.push({stage:'mount-contacts',contacts});
  record('lowered');expect(permitted).toBe(true);
  const install=w.action('human',{type:'install-drive',itemId:'ferry-drive',targetId:'ferry-deck'});trace.push({stage:'install',result:install.result});expect(install.result.ok).toBe(true);
  for(let i=0;i<130;i++){step(1);if(i%20===0)record(`align-${i}`);}
  record('completed');expect(view().machinery.ferry?.driveId).toBe('ferry-drive');
  const publicDrive=view().entities.find(e=>e.id==='ferry-drive')!,publicDeck=view().entities.find(e=>e.id==='ferry-deck')!;
  const own=publicDrive.sockets.find(s=>s.id==='drive')!,target=publicDeck.sockets.find(s=>s.id==='drive')!;
  expect(distance(own.world,target.world)).toBeLessThan(.01);
  expect(publicDrive.position.y-publicDeck.position.y).toBeCloseTo(-.6,2);
 }finally{record('final');evidence('ferry-mount-ordinary-inputs',{kind:'fresh authored quarry; ordinary public input/actions only; technical traversal, not browser acceptance',trace},'ordinary public controls from authored map spawn; not browser acceptance');w.dispose();}
},60000);
