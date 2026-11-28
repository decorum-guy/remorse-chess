import { describe, expect, it } from 'vitest';
import { evidence } from './evidence';
import { TyagaWorld, PHYSICS_BUILD_HASH } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { length, distance, V, add } from '../src/core/math';
import type { MapId } from '../src/core/types';

const participants=[{participantId:'alice',displayName:'Alice',seatIndex:0,bot:false},{participantId:'bob',displayName:'Bob',seatIndex:1,bot:false}];
async function create(mapId:MapId='valley'){return TyagaWorld.create({matchId:`test-${mapId}`,mapId,participants});}
function step(w:TyagaWorld,n:number,inputs:Record<string,unknown>={}){for(let i=0;i<n;i++)w.step(inputs);}

describe('Tyaga authoritative Rapier world',()=>{
  it.each<MapId>(['valley','quarry','ridge','tutorial'])('settles %s with real mass and no resting damage',async(mapId)=>{
    const w=await create(mapId);
    try{
      const view=w.view('alice');
      const mass=Object.values(w.state.entities).filter(e=>e.active&&!e.fixed&&e.kind!=='rope-segment').reduce((n,e)=>n+w.body(e.id).mass(),0);
      console.log('SETTLE',mapId,JSON.stringify({truck:view.entities.find(e=>e.id==='truck')?.position,velocity:view.entities.find(e=>e.id==='truck')?.velocity,cargo:view.entities.filter(e=>e.required).map(e=>({id:e.id,position:e.position,integrity:e.integrity,mass:e.mass})),mass,links:view.connections.map(l=>({id:l.id,force:l.tension,broken:l.broken})),grounded:w.state.characters.alice.grounded}));
      expect(w.state.phase).toBe('running');expect(w.body('truck').translation().y).toBeGreaterThan(.5);
      expect(Object.values(w.state.links).filter(l=>!l.broken&&l.kind==='strap')).toHaveLength(10);
      step(w,180);
      console.log('AFTER',mapId,w.state.phase,JSON.stringify(w.state.events),JSON.stringify(Object.values(w.state.entities).filter(e=>e.required).map(e=>({id:e.id,h:e.integrity,pos:w.body(e.id).translation(),vel:w.body(e.id).linvel()}))));
      expect(w.state.phase).toBe('running');for(const e of Object.values(w.state.entities).filter(e=>e.required))expect(e.integrity).toBe(100);
      expect(length(w.body('truck').linvel())).toBeLessThan(.2);
      expect(w.state.characters.alice.grounded).toBe(true);
      expect(mass).toBeGreaterThan(1050);
    }finally{w.dispose();}
  });
  it('replays the complete physical snapshot deterministically',async()=>{
    const w=await create();let copy:TyagaWorld|undefined;
    try{
      step(w,12,{alice:{...NEUTRAL_INPUT,moveX:1}});
      const snap=w.serialize();copy=await TyagaWorld.restore(snap);
      expect(copy.serialize()).toBe(snap);
      for(let i=0;i<90;i++){const inputs={alice:{...NEUTRAL_INPUT,moveX:i<45?1:0,moveZ:i>45?.5:0}};w.step(inputs);copy.step(inputs);}
      expect(copy.serialize()).toBe(w.serialize());
      expect(PHYSICS_BUILD_HASH).toContain('17cfa80e');
    }finally{w.dispose();copy?.dispose();}
  });
  it('P01 launches a grounded capsule with the prescribed physical impulse',async()=>{
    const w=await create();try{const before=w.body('person:alice').linvel().y;const start=w.body('person:alice').translation().y;const r=w.action('alice',{type:'jump'});expect(r.result.ok).toBe(true);const impulseVelocity=w.body('person:alice').linvel().y-before;expect(impulseVelocity).toBeCloseTo(4.6,4);step(w,25);const heightAt25=w.body('person:alice').translation().y;expect(w.body('person:alice').translation().y).toBeGreaterThan(start+.8);step(w,90);expect(w.body('person:alice').translation().y).toBeCloseTo(start,1);evidence('P01-jump',{impulseVelocity,start,heightAt25,landedY:w.body('person:alice').translation().y});}finally{w.dispose();}
  });
});

it('keeps a parked truck stationary through two minutes of real contact simulation',async()=>{
 const w=await create('tutorial');try{const start={...w.body('truck').translation()};step(w,7200);evidence('parked-flat', {steps:7200,displacement:distance(start,w.body('truck').translation()),start,end:{...w.body('truck').translation()},cargo:Object.values(w.state.entities).filter(e=>e.required).map(e=>({id:e.id,integrity:e.integrity,position:{...w.body(e.id).translation()}}))});expect(distance(start,w.body('truck').translation())).toBeLessThan(.12);}finally{w.dispose();}
});

it.each(['deck','truck']as const)('P01 jumps from a moving %s without deleting support momentum',async(kind)=>{
 const w=await create('tutorial');try{
  let supportId='truck';
  if(kind==='deck'){supportId='jump-deck';w.addBody({id:supportId,kind:'deck',position:V(6,.2,6)});step(w,20);}
  const support=w.body(supportId);const position=kind==='truck'?w.bodyPoint('truck',V(-2.7,.35+.9,0)):add(support.translation(),V(0,.09+.9,0));
  const actor=w.body('person:alice');actor.setTranslation(position,true);actor.setLinvel(V(),true);step(w,60);
  expect(w.state.characters.alice.grounded).toBe(true);expect(w.state.characters.alice.groundBodyId).toBe(supportId);
  // The fixture gives the already-supported physical pair an initial velocity;
  // the ordinary jump command must retain it, rather than assign a new velocity.
  support.setLinvel(V(.7,.2,.3),true);actor.setLinvel(V(.7,.2,.3),true);
  const before={...actor.linvel()},start={...actor.translation()};expect(w.action('alice',{type:'jump'}).result.ok).toBe(true);
  const launched={...actor.linvel()};expect(launched.x).toBeCloseTo(before.x,5);expect(launched.z).toBeCloseTo(before.z,5);expect(launched.y-before.y).toBeCloseTo(4.6,4);
  step(w,20);evidence(`P01-moving-${kind}`,{initialSupportVelocity:before,launched,start,after20:{...actor.translation()},grounded:w.state.characters.alice.grounded});expect(actor.translation().y).toBeGreaterThan(start.y+.8);
 }finally{w.dispose();}
});
