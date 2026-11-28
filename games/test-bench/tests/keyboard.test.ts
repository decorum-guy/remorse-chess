import { mkdirSync,writeFileSync } from 'node:fs';
import { expect,it } from 'vitest';
import { chooseBotInput } from '../src/bots';
import { PARTS,PRESETS } from '../src/catalog';
import { createPhysicsLane } from '../src/physics';
import { getTrack,TRACK_ORDER } from '../src/tracks';

it('drives a cup through quantized keyboard inputs sampled every33ms',async()=>{
  const report=[];
  for(const trackId of TRACK_ORDER){
    const track=getTrack(trackId);const lane=await createPhysicsLane({blueprint:PRESETS.gentle,track});let snapshot=lane.snapshot();
    while(!snapshot.finished){const d=chooseBotInput(snapshot,track,'normal');if(d.interact)lane.interact();if(d.restore)lane.restore();const desired=d.input.steering*(33-16*Math.min(1,snapshot.car.speed/PARTS[snapshot.blueprint.motor].maxSpeed!))*Math.PI/180;const actual=snapshot.car.wheels[0]?.steering??0;const steering=desired>.02?(actual<desired?1:0):desired<-.02?(actual>desired?-1:0):0;const input={throttle:d.input.throttle>.05?1:0,steering,brake:d.input.brake};for(let tick=0;tick<2&&!snapshot.finished;tick++)snapshot=lane.step(input);}
    report.push({trackId,result:snapshot.result,position:snapshot.car.position,yaw:snapshot.car.yaw,speed:snapshot.car.speed,wheels:snapshot.car.wheels.map(w=>w.steering),events:snapshot.events,gates:snapshot.gatesPassed});lane.dispose();
  }
  mkdirSync('.qa/test-bench',{recursive:true});writeFileSync('.qa/test-bench/keyboard-profile.json',JSON.stringify(report,null,2));expect(report.filter(row=>!row.result?.finished)).toEqual([]);
});
