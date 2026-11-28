import type { BotDifficulty } from '@iva-games/session-kit';
import { PRESETS, blueprintCost, blueprintEdits, validateBlueprint } from './catalog';
import type { Blueprint, DriveInput, LaneSnapshot, TrackDefinition } from './types';

const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
const angle=(value:number)=>Math.atan2(Math.sin(value),Math.cos(value));
/** Only the bot's current lane and the publicly announced track enter its policy. */
export function chooseBotInput(lane:Readonly<LaneSnapshot>,track:TrackDefinition,difficulty:BotDifficulty):{input:DriveInput;interact:boolean;restore:boolean}{
  const car=lane.car;
  if(lane.finished)return {input:{throttle:0,steering:0,brake:true},interact:false,restore:false};
  const awaiting=lane.cargo.some(c=>c.status==='at-dock');
  let target={x:0,z:(track.unload.minZ+track.unload.maxZ)/2};
  let desiredSpeed=difficulty==='easy'?2.35:difficulty==='normal'?3.0:3.65;
  if(awaiting)target={x:track.loadingDock.x,z:track.loadingDock.z+0.12};
  else if(lane.gatesPassed<track.orderedGates.length){const gate=track.orderedGates[lane.gatesPassed];target={x:gate.x,z:gate.z+1.0};if(track.id==='precision'){const prior=track.orderedGates[lane.gatesPassed-1];if(prior&&car.position.z<prior.z+1.4)target={x:prior.x,z:prior.z+3};else if(car.position.z<gate.z-2.2)target={x:gate.x,z:gate.z-1.7};}}
  const remainingZ=target.z-car.position.z;
  if(track.id==='fragile'&&!awaiting){const nextRib=track.ribs.find(r=>r.z>car.position.z-1&&r.z<car.position.z+4);if(nextRib){desiredSpeed=difficulty==='easy'?1.15:difficulty==='normal'?1.45:1.8;if(lane.blueprint.cargo==='platform')desiredSpeed=Math.min(desiredSpeed,1.45);}}
  if(track.id==='precision')desiredSpeed=Math.min(desiredSpeed,difficulty==='hard'?2.35:1.85);
  if(awaiting||lane.gatesPassed===track.orderedGates.length)desiredSpeed=Math.min(desiredSpeed,Math.max(0,(remainingZ-0.25)*1.0));
  const dx=target.x-car.position.x;const dz=target.z-car.position.z;const heading=Math.atan2(dx,Math.max(2,dz));const error=angle(heading-car.yaw);
  const steering=clamp(error*2.3,-1,1);
  if(Math.abs(error)>0.45)desiredSpeed=Math.min(desiredSpeed,1.6);
  const braking=car.speed>desiredSpeed+0.22||desiredSpeed<0.18;
  const throttle=braking?0:clamp((desiredSpeed-car.speed)*0.9,0,1);
  const stuck=car.tilt>80&&lane.tiltTicks>75;
  const missed=car.position.z>target.z+2;
  const depleted=car.charge<=0&&car.speed<0.15;
  return {input:{throttle,steering,brake:braking},interact:lane.interaction==='load'||lane.interaction==='pickup',restore:(stuck||missed)&&!depleted};
}
export function chooseBotBlueprint(previous:Blueprint|null,stage:number,difficulty:BotDifficulty):Blueprint{
  const target=structuredClone(stage===0?(difficulty==='easy'?PRESETS.universal:PRESETS.gentle):stage===2?PRESETS.tractor:PRESETS.universal);
  if(!previous)return target;
  const best=structuredClone(previous);const priorities=(stage===2?['motor','rear-axle','front-axle','battery','cargo','aux-left','aux-right']:['front-axle','rear-axle','cargo','motor','battery','aux-left','aux-right']) as (keyof Blueprint)[];
  for(const slot of priorities){const candidate={...best,[slot]:target[slot]} as Blueprint;try{validateBlueprint(candidate,previous);Object.assign(best,candidate);}catch{continue;}}
  if(blueprintCost(best)>16||blueprintEdits(best,previous)>2)return structuredClone(previous);
  return best;
}
