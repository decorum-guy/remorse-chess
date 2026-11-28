import RAPIER from '@dimforge/rapier3d-compat';
import { describe,expect,it } from 'vitest';
import { chooseBotInput } from '../src/bots';
import { PRESETS } from '../src/catalog';
import { createPhysicsLane,NEUTRAL_INPUT,decodePhysicsSnapshot,encodePhysicsSnapshot,selectEjectedCargo } from '../src/physics';
import { getTrack } from '../src/tracks';
import type { Blueprint,LaneCheckpoint,Quaternion,Vec3 } from '../src/types';

function positionFixture(snapshot:LaneCheckpoint,position:Vec3,rotation:Quaternion={x:0,y:0,z:0,w:1},velocity:Vec3={x:0,y:0,z:0}):LaneCheckpoint{
  const world=RAPIER.World.restoreSnapshot(decodePhysicsSnapshot(snapshot.world));const body=world.getRigidBody(snapshot.chassisHandle);body.setTranslation(position,true);body.setRotation(rotation,true);body.setLinvel(velocity,true);body.setAngvel({x:0,y:0,z:0},true);const result={...snapshot,world:encodePhysicsSnapshot(world.takeSnapshot())};world.free();return result;
}
async function loaded(blueprint:Blueprint=PRESETS.universal){const track=getTrack('fragile');const lane=await createPhysicsLane({blueprint,track});for(let i=0;i<300;i++){const s=lane.snapshot();const action=chooseBotInput(s,track,'normal');if(action.interact){expect(lane.interact()).toBe(true);break;}lane.step(action.input);}expect(lane.snapshot().cargo.every(c=>c.status==='secured')).toBe(true);return lane;}

describe('physical cargo lifecycle',()=>{
  it('issues each dock item once and a reset preserves cargo, charge and elapsed ticks',async()=>{
    const lane=await loaded();const before=lane.snapshot();expect(lane.interact()).toBe(false);lane.restore();const after=lane.snapshot();expect(after.tick).toBe(before.tick);expect(after.car.charge).toBe(before.car.charge);expect(after.cargo.map(c=>c.health)).toEqual(before.cargo.map(c=>c.health));expect(after.resets).toBe(1);lane.restore();expect(lane.snapshot().resets).toBe(1);lane.dispose();
  });
  it('releases tilted cargo into dynamic bodies, leaves dropped items on reset and picks the nearest intact item',async()=>{
    const source=await loaded();let cp=positionFixture(source.checkpoint(),{x:0,y:1.5,z:5},{x:0,y:0,z:1,w:0});source.dispose();
    let lane=await createPhysicsLane({blueprint:PRESETS.universal,track:getTrack('fragile'),snapshot:cp});for(let i=0;i<23;i++)lane.step(NEUTRAL_INPUT);
    let state=lane.snapshot();expect(state.cargo.some(c=>c.status==='loose')).toBe(true);const dropped=state.cargo.find(c=>c.status==='loose')!;const position={...dropped.position};const charge=state.car.charge;lane.restore();state=lane.snapshot();expect(state.car.charge).toBe(charge);expect(state.cargo.find(c=>c.id===dropped.id)?.position).toEqual(position);
    cp=positionFixture(lane.checkpoint(),{x:position.x,y:0.35,z:position.z+0.12});lane.dispose();lane=await createPhysicsLane({blueprint:PRESETS.universal,track:getTrack('fragile'),snapshot:cp});
    expect(lane.interact()).toBe(true);expect(lane.snapshot().cargo.filter(c=>c.status==='secured')).toHaveLength(1);expect(lane.snapshot().cargo.find(c=>c.id===dropped.id)?.health).toBe(dropped.health);lane.dispose();
  });
  it('uses swept gates at high speed and does not award unloading without all gates',async()=>{
    const source=await loaded();let cp=positionFixture(source.checkpoint(),{x:0,y:0.4,z:17.98},undefined,{x:0,y:0,z:7});source.dispose();let lane=await createPhysicsLane({blueprint:PRESETS.universal,track:getTrack('fragile'),snapshot:cp});lane.step({throttle:1,steering:0,brake:false});expect(lane.snapshot().gatesPassed).toBe(1);
    cp=positionFixture(lane.checkpoint(),{x:0,y:0.35,z:43});lane.dispose();lane=await createPhysicsLane({blueprint:PRESETS.universal,track:getTrack('fragile'),snapshot:cp});for(let i=0;i<60;i++)lane.step(NEUTRAL_INPUT);expect(lane.snapshot().finished).toBe(false);expect(lane.snapshot().unloadTicks).toBe(0);lane.dispose();
  });
  it('opens a depleted clamp and retains brakes and inertia',async()=>{
    const source=await createPhysicsLane({blueprint:PRESETS.tractor,track:getTrack('climb')});for(let i=0;i<300;i++){const d=chooseBotInput(source.snapshot(),getTrack('climb'),'normal');if(d.interact){source.interact();break;}source.step(d.input);}
    let cp=source.checkpoint();cp.car.charge=0;cp=positionFixture(cp,{x:0,y:1.5,z:5},{x:0,y:0,z:Math.sin(45*Math.PI/360),w:Math.cos(45*Math.PI/360)});source.dispose();
    const lane=await createPhysicsLane({blueprint:PRESETS.tractor,track:getTrack('climb'),snapshot:cp});for(let i=0;i<23;i++)lane.step({throttle:1,steering:0,brake:true});expect(lane.snapshot().car.charge).toBe(0);expect(lane.snapshot().cargo.some(c=>c.status==='loose')).toBe(true);lane.dispose();
  });
  it('preserves more integrity with springs on the same rib at the same entry speed',async()=>{
    const outcomes:number[]=[];
    for(const cargo of ['platform','cradle'] as const){
      const blueprint={...PRESETS.universal,cargo};const source=await loaded(blueprint);const cp=positionFixture(source.checkpoint(),{x:0,y:0.35,z:9},undefined,{x:0,y:0,z:6});source.dispose();
      const lane=await createPhysicsLane({blueprint,track:getTrack('fragile'),snapshot:cp});
      for(let tick=0;tick<300&&lane.snapshot().car.position.z<16;tick++)lane.step({throttle:1,steering:0,brake:false});
      outcomes.push(lane.snapshot().cargo.reduce((sum,c)=>sum+c.health,0));lane.dispose();
    }
    expect(outcomes[0]).toBeLessThan(300);expect(outcomes[1]).toBeGreaterThan(outcomes[0]);
  });
  it('selects the cargo socket in the impact direction and refuses vertically distant loading',async()=>{
    const source=await loaded();const state=source.snapshot();expect(selectEjectedCargo(state.cargo,{x:0,y:0,z:0,w:1},{x:1,y:0,z:0})?.slot).toBe(2);expect(selectEjectedCargo(state.cargo,{x:0,y:0,z:0,w:1},{x:-1,y:0,z:0})?.slot).toBe(0);source.dispose();
    const empty=await createPhysicsLane({blueprint:PRESETS.universal,track:getTrack('fragile')});const cp=positionFixture(empty.checkpoint(),{x:0,y:5,z:3});empty.dispose();const airborne=await createPhysicsLane({blueprint:PRESETS.universal,track:getTrack('fragile'),snapshot:cp});expect(airborne.interact()).toBe(false);airborne.dispose();
  });

});
