import { describe,expect,it } from 'vitest';
import { axleGrip,blueprintCost,blueprintEdits,PRESETS,validateBlueprint } from '../src/catalog';
import { chooseBotBlueprint } from '../src/bots';
import { rankCup,rankStage } from '../src/rules';
import { crossedGate,getTrack,groundHeight,terrainMesh } from '../src/tracks';
import type { Blueprint,LaneResult,StageRecord } from '../src/types';

describe('catalog and fair scoring',()=>{
  it('counts the actual catalogue price and rejects the seventeenth token atomically',()=>{
    expect(Object.values(PRESETS).map(blueprintCost)).toEqual([10,15,15]);
    const accepted=validateBlueprint({...PRESETS.tractor,'front-axle':'high'});expect(blueprintCost(accepted)).toBe(16);
    expect(()=>validateBlueprint({...accepted,'rear-axle':'high'})).toThrow('OVER_BUDGET');expect(accepted['rear-axle']).toBe('terrain');
  });
  it('counts a ballast move as two changed slots, restores edits on undo and rejects a third',()=>{
    const previous:Blueprint={...PRESETS.universal,'aux-left':'ballast'};
    const moved:Blueprint={...previous,'aux-left':null,'aux-right':'ballast'};expect(blueprintEdits(moved,previous)).toBe(2);expect(validateBlueprint(moved,previous)).toEqual(moved);
    expect(()=>validateBlueprint({...moved,motor:'torque'},previous)).toThrow('TOO_MANY_EDITS');expect(blueprintEdits(previous,previous)).toBe(0);
  });
  it('rejects incompatible parts and duplicated unique attachments',()=>{
    expect(()=>validateBlueprint({...PRESETS.universal,motor:'high'})).toThrow('INVALID_PART');
    expect(()=>validateBlueprint({...PRESETS.universal,'aux-left':'rollbar','aux-right':'rollbar'})).toThrow('DUPLICATE_MODULE');
  });
  it('ranks delivered cargo first, then integrity then tick time; exact ties share points and skip places',()=>{
    const make=(participantId:string,delivered:number,integrity:number,elapsedTicks:number,finished=true):LaneResult=>({participantId,delivered,integrity,elapsedTicks,resets:0,finished});
    const result=rankStage([make('a',3,220,800),make('b',2,200,200),make('c',3,220,800),make('d',0,0,3900,false)]);
    expect(result.map(r=>[r.participantId,r.place,r.points])).toEqual([['a',1,4],['c',1,4],['b',3,2],['d',4,0]]);
    const stages=[{stage:0,trackId:'fragile',mirrored:false,results:result,blueprints:{},events:{}}] as StageRecord[];
    expect(rankCup(['a','b','c','d'].map(participantId=>({participantId})),stages).filter(r=>r.place===1).map(r=>r.participantId)).toEqual(['a','c']);
  });
  it('gives zero points to an unfinished lane even with a fabricated delivered field',()=>{expect(rankStage([{participantId:'x',delivered:3,integrity:300,elapsedTicks:3900,resets:0,finished:false}])[0].points).toBe(0);});
  it('sweeps fast gate crossings, rejects wrong direction and shares mirrored height boundaries',()=>{
    const gate={x:1.45,z:10,width:2.1};expect(crossedGate({x:1.45,y:0,z:9},{x:1.45,y:0,z:12},gate)).toBe(true);
    expect(crossedGate({x:1.45,y:0,z:12},{x:1.45,y:0,z:9},gate)).toBe(false);
    expect(crossedGate({x:-2,y:0,z:9},{x:-2,y:0,z:12},gate)).toBe(false);
    for(const x of [-3,-2,0,2,3])for(const z of [11,12,19,21,26,34,36])expect(groundHeight(getTrack('fragile'),x,z)).toBe(groundHeight(getTrack('fragile',true),-x,z));
  });
  it('uses the specified wet coefficients for road and high axles independently of dry grip',()=>{
    expect(axleGrip('road',true)).toEqual({lateral:0.54,longitudinal:0.64});expect(axleGrip('high',true)).toEqual({lateral:0.54,longitudinal:0.64});
    expect(axleGrip('high',false)).toEqual({lateral:0.82,longitudinal:0.96});expect(axleGrip('terrain',true)).toEqual({lateral:0.85,longitudinal:0.9});
  });
  it('keeps the climb endpoints while giving both transition chamfers half the main slope',()=>{
    const track=getTrack('climb');expect(groundHeight(track,0,24)).toBe(0);expect(groundHeight(track,0,34)).toBe(2.9);
    const lower=(groundHeight(track,0,24.3)-groundHeight(track,0,24))/.3;const main=groundHeight(track,0,26)-groundHeight(track,0,25);const upper=(groundHeight(track,0,34)-groundHeight(track,0,33.7))/.3;
    expect(main).toBeCloseTo(lower*2,10);expect(upper).toBeCloseTo(lower,10);
    const {vertices}=terrainMesh(track);const z=[...vertices].filter((_,i)=>i%3===2);expect(z.some(value=>Math.abs(value-24.6)<.00001)).toBe(true);expect(z.some(value=>Math.abs(value-33.4)<.00001)).toBe(true);
  });
  it('keeps every bot refit in budget and within two slots for every difficulty',()=>{
    for(const difficulty of ['easy','normal','hard'] as const){let previous:Blueprint|null=null;for(let stage=0;stage<3;stage++){const next=chooseBotBlueprint(previous,stage,difficulty);expect(()=>validateBlueprint(next,previous)).not.toThrow();previous=next;}}
  });
});
