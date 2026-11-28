import { describe,expect,it } from 'vitest';
import { PRESETS } from '../src/catalog';
import { chooseBotInput } from '../src/bots';
import { cargoDamage,createPhysicsLane,NEUTRAL_INPUT } from '../src/physics';
import { getTrack,TRACK_ORDER } from '../src/tracks';

describe('authoritative Test Bench physics',()=>{
  it('applies the specified impact thresholds',()=>{expect(cargoDamage('egg',1.55)).toBe(44);expect(cargoDamage('egg',1.55,0.58)).toBe(16);});
  it('supports the chassis on four ray springs and restores exact dynamics from a checkpoint',async()=>{
    const lane=await createPhysicsLane({blueprint:PRESETS.universal,track:getTrack('fragile')});
    for(let i=0;i<60;i++)lane.step(NEUTRAL_INPUT);
    const before=lane.snapshot();expect(before.car.wheels.filter(w=>w.grounded)).toHaveLength(4);expect(before.car.position.y).toBeGreaterThan(0.12);
    const restored=await createPhysicsLane({blueprint:PRESETS.universal,track:getTrack('fragile'),snapshot:lane.checkpoint()});
    for(let i=0;i<120;i++){lane.step({throttle:0.3,steering:0.1,brake:false});restored.step({throttle:0.3,steering:0.1,brake:false});}
    expect(restored.snapshot()).toEqual(lane.snapshot());lane.dispose();restored.dispose();
  });
  it.each(TRACK_ORDER)('finishes %s using the same driving inputs as a player',async trackId=>{
    const track=getTrack(trackId);const lane=await createPhysicsLane({blueprint:PRESETS.universal,track});
    for(let i=0;i<3900&&!lane.snapshot().finished;i++){const decision=chooseBotInput(lane.snapshot(),track,'normal');if(decision.interact)lane.interact();if(decision.restore)lane.restore();lane.step(decision.input);}
    const result=lane.snapshot();console.info(trackId,JSON.stringify({result:result.result,car:result.car.position,charge:result.car.charge,gates:result.gatesPassed,cargo:result.cargo.map(c=>({status:c.status,health:c.health})),events:result.events}));
    expect(result.result?.finished).toBe(true);expect(result.result?.delivered).toBeGreaterThan(0);lane.dispose();
  });
});
