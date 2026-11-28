import { expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { TyagaWorld } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { clamp, Q, V } from '../src/core/math';
import { evidence } from './evidence';

it.each([false,true])('a dynamic capsule climbs the actual 22-cm lift stairs while supported by their edges; carrying drive=%s',async carrying=>{
 const w=await TyagaWorld.create({matchId:'stair-contact-fixture',mapId:'ridge',mode:'practice',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'other',displayName:'Other',seatIndex:1,bot:false}]});
 const trace:unknown[]=[];
 try{
  // Explicit initial pose for this local regression only. The separate access
  // integration test starts at the original map spawn and walks the whole way.
  const actor=w.body('person:human');actor.setTranslation(V(209.8,10.9,67),true);actor.setLinvel(V(),true);
  if(carrying){const drive=w.body('lift-drive');drive.setTranslation(V(208.8,10.65,67),true);drive.setRotation(Q(),true);drive.setLinvel(V(),true);drive.setAngvel(V(),true);}
  for(let i=0;i<20;i++)w.step();
  if(carrying){expect(w.action('human',{type:'grab',itemId:'lift-drive',handleId:'handle-0'}).result.ok).toBe(true);for(let i=0;i<120;i++)w.step({human:{...NEUTRAL_INPUT,tool:1}});}
  let reached=false;
  for(let i=0;i<2700;i++){
   const p=actor.translation();if(p.x>218){reached=true;break;}
   if(i%30===0){const contacts:unknown[]=[];for(const h of w.state.entities['person:human'].colliders){const c=w.physics.getCollider(h);w.physics.contactPairsWith(c,other=>w.physics.contactPair(c,other,(m,flipped)=>{if(m.numSolverContacts())contacts.push({other:w.state.colliderBodies[other.handle],normal:{...m.normal()},flipped,point:m.solverContactPoint(0),distance:m.solverContactDist(0)});}));}
    const ray=w.physics.castRay(new RAPIER.Ray({x:p.x,y:p.y-.86,z:p.z},V(1,0,0)),.5,true,undefined,undefined,undefined,actor);
    trace.push({i,position:{...p},velocity:{...actor.linvel()},grounded:w.state.characters.human.grounded,groundBody:w.state.characters.human.groundBodyId,force:actor.userForce(),lowHit:ray?{other:w.state.colliderBodies[ray.collider.handle],distance:ray.timeOfImpact}:null,contacts});
   }
   w.step({human:{...NEUTRAL_INPUT,moveX:1,moveZ:clamp((67-p.z)*3,-1,1)}});
  }
  expect(reached).toBe(true);expect(actor.translation().y).toBeGreaterThan(16.7);if(carrying)expect(w.view('human').participants.find(p=>p.participantId==='human')?.holding).toBe('lift-drive');
 }finally{evidence(`P01-stair-contact-support${carrying?'-with-drive':''}`,{trace});w.dispose();}
},60000);

it('a person carrying the 40-kg drive steps onto the actual hinged ferry ramp',async()=>{
 const w=await TyagaWorld.create({matchId:'ramp-step-fixture',mapId:'quarry',mode:'practice',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'other',displayName:'Other',seatIndex:1,bot:false}]});
 const trace:unknown[]=[];
 try{
  // Initial setup only: all subsequent movement and loading remain dynamic.
  const actor=w.body('person:human');actor.setTranslation(V(34.9,-1.9,64),true);actor.setLinvel(V(),true);
  const drive=w.body('ferry-drive');drive.setTranslation(V(34,-2.18,64),true);drive.setRotation(Q(),true);drive.setLinvel(V(),true);drive.setAngvel(V(),true);
  for(let i=0;i<30;i++)w.step();expect(w.action('human',{type:'grab',itemId:'ferry-drive',handleId:'handle-0'}).result.ok).toBe(true);
  for(let i=0;i<120;i++)w.step({human:{...NEUTRAL_INPUT,tool:1}});
  let reached=false;for(let i=0;i<900;i++){
   const p=actor.translation();if(p.x>39.5){reached=true;break;}if(i%15===0)trace.push({i,actor:{...p},drive:{...drive.translation()},grounded:w.state.characters.human.grounded,holding:w.state.characters.human.holding?.itemId,ramp:{...w.body('near-ramp').translation()}});
   w.step({human:{...NEUTRAL_INPUT,moveX:1,moveZ:clamp((64-p.z)*3,-1,1)}});
  }
  expect(reached).toBe(true);expect(actor.translation().y).toBeGreaterThan(-1.6);expect(w.view('human').participants.find(p=>p.participantId==='human')?.holding).toBe('ferry-drive');
 }finally{evidence('P01-loaded-ramp-step',{trace});w.dispose();}
},60000);
