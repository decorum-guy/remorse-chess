import { expect, it } from 'vitest';
import { TyagaWorld } from '../src/server-world/world';
import { observedGround } from '../src/bots';
import { clamp, V } from '../src/core/math';
import { evidence } from './evidence';

it('Quarry junctions share the real main-road grade and bots query the actual triangle surface',async()=>{
 const w=await TyagaWorld.create({matchId:'junction-geometry-fixture',mapId:'quarry',mode:'practice',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'other',displayName:'Other',seatIndex:1,bot:false}]});
 try{
  const view=w.view('human');
  for(const x of [83,84,85,86,87,88,89,90,91])for(const z of [46.8,48,49.2]){
   const expected=-4+4*clamp((x-72)/18,0,1),physical=w.ground(V(x,4,z),10)?.point.y,observed=observedGround(view,V(x,2,z));
   expect(physical).toBeCloseTo(expected,3);expect(observed).toBeCloseTo(physical!,3);
  }
  // Inside the mesh's bounding box but outside the actual road footprint.
  expect(w.ground(V(80.5,2,60),10)).toBeNull();expect(observedGround(view,V(80.5,2,60))).toBeNull();
 }finally{w.dispose();}
});

it('Quarry shelf is physically higher at the Z46 side and lower at Z50',async()=>{
 const w=await TyagaWorld.create({matchId:'shelf-crossfall-fixture',mapId:'quarry',mode:'practice',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'other',displayName:'Other',seatIndex:1,bot:false}]});
 try{
  const view=w.view('human');
  // Sample 25 cm inside each authored edge so the rotated four-metre
  // surface, not a bounding-box extension beyond it, supplies both hits.
  const samples=[125.5,130.5,139.5].map(x=>({x,high:w.ground(V(x,10,46.25),20)?.point.y,low:w.ground(V(x,10,49.75),20)?.point.y,observedHigh:observedGround(view,V(x,8,46.25)),observedLow:observedGround(view,V(x,8,49.75))}));
  evidence('R05-quarry-shelf-crossfall',{highSideZ:46,lowSideZ:50,probeZ:[46.25,49.75],samples});
  const expectedDrop=3.5*Math.tan(18*Math.PI/180)/Math.cos(Math.atan2(4,26));
  for(const s of samples){
   expect(s.high).toBeDefined();expect(s.low).toBeDefined();expect(s.high!-s.low!).toBeCloseTo(expectedDrop,3);
   expect(s.observedHigh).toBeCloseTo(s.high!,3);expect(s.observedLow).toBeCloseTo(s.low!,3);
  }
 }finally{w.dispose();}
});
