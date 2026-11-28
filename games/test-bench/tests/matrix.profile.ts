import { mkdirSync,writeFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';
import { chooseBotInput } from '../src/bots';
import { PRESETS } from '../src/catalog';
import { createPhysicsLane } from '../src/physics';
import { getTrack,TRACK_ORDER } from '../src/tracks';

describe('reproducible real-engine balance matrix',()=>{
  it('drives all three builds, tracks, difficulties and mirror variants without special physics',async()=>{
    const report=[];const bad=[];
    for(const [preset,blueprint] of Object.entries(PRESETS))for(const trackId of TRACK_ORDER)for(const difficulty of ['easy','normal','hard'] as const)for(const mirrored of [false,true]){
      const track=getTrack(trackId,mirrored);const lane=await createPhysicsLane({blueprint,track});
      const durations:number[]=[];let snapshot=lane.snapshot();
      for(let i=0;i<3900&&!snapshot.finished;i++){
        const command=chooseBotInput(snapshot,track,difficulty);if(command.interact)lane.interact();if(command.restore)lane.restore();
        const start=performance.now();snapshot=lane.step(command.input);durations.push(performance.now()-start);
      }
      durations.sort((a,b)=>a-b);const row={preset,trackId,difficulty,mirrored,result:snapshot.result,charge:snapshot.car.charge,position:snapshot.car.position,gates:snapshot.gatesPassed,stepP95Ms:durations[Math.floor(durations.length*.95)]};report.push(row);if(!snapshot.result?.finished)bad.push(row);lane.dispose();
    }
    mkdirSync('.qa/test-bench',{recursive:true});writeFileSync('.qa/test-bench/physics-matrix.json',JSON.stringify(report,null,2));
    expect(bad).toEqual([]);
  },30000);
});
