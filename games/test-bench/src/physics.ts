import RAPIER from '@dimforge/rapier3d-compat';
import type { RigidBody, Collider } from '@dimforge/rapier3d-compat';
import { axleGrip, blueprintMass, PARTS, validateBlueprint } from './catalog';
import { CARGO_PROFILES, crossedGate, groundHeight, isWet, terrainMesh } from './tracks';
import { STEP, RACE_TICKS } from './types';
import type { BenchEvent, Blueprint, CargoKind, CargoState, DriveInput, LaneCheckpoint, LaneSnapshot, Quaternion, TrackDefinition, Vec3 } from './types';

export interface PhysicsLaneOptions { blueprint: Blueprint; track: TrackDefinition; participantId?: string; snapshot?: LaneCheckpoint; cargoCount?: 1 | 3; raceLimitTicks?: number }
export function encodePhysicsSnapshot(bytes:Uint8Array):string {
  if(typeof Buffer!=='undefined')return Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).toString('base64');
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);
}
export function decodePhysicsSnapshot(value:string):Uint8Array {
  if(typeof Buffer!=='undefined')return new Uint8Array(Buffer.from(value,'base64'));
  const binary=atob(value);return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
const ZERO: Vec3 = {x:0,y:0,z:0};
const IDENTITY: Quaternion = {x:0,y:0,z:0,w:1};
export const NEUTRAL_INPUT: DriveInput = {throttle:0,steering:0,brake:true};
let initialization: Promise<void> | undefined;
export function initPhysics(): Promise<void> { initialization ??= RAPIER.init(); return initialization; }
const clamp=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
const vec=(v:Vec3):Vec3=>({x:v.x,y:v.y,z:v.z});
const quat=(q:Quaternion):Quaternion=>({x:q.x,y:q.y,z:q.z,w:q.w});
const add=(a:Vec3,b:Vec3):Vec3=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const scale=(a:Vec3,b:number):Vec3=>({x:a.x*b,y:a.y*b,z:a.z*b});
const dot=(a:Vec3,b:Vec3)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a:Vec3,b:Vec3):Vec3=>({x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
export function rotateVector(q:Quaternion,v:Vec3):Vec3 {const t=scale(cross(q,v),2);return add(v,add(scale(t,q.w),cross(q,t)));}
function localToWorld(body:RigidBody,p:Vec3):Vec3{return add(body.translation(),rotateVector(body.rotation(),p));}
export function selectEjectedCargo(cargo:CargoState[],rotation:Quaternion,direction:Vec3):CargoState|undefined {
  const local=rotateVector({x:-rotation.x,y:-rotation.y,z:-rotation.z,w:rotation.w},direction);
  return cargo.filter(c=>c.status==='secured').sort((a,b)=>Math.abs(local.x)>0.0001?(b.slot-a.slot)*Math.sign(local.x):Math.abs(b.slot-1)-Math.abs(a.slot-1)||a.id.localeCompare(b.id))[0];
}
function pointVelocity(body:RigidBody,p:Vec3,center?:Vec3):Vec3 {const c=center??body.worldCom();return add(body.linvel(),cross(body.angvel(),{x:p.x-c.x,y:p.y-c.y,z:p.z-c.z}));}
export function cargoSocket(blueprint:Blueprint,slot:number):Vec3{return {x:(slot-1)*0.42,y:0.33+(blueprint.cargo==='cradle'?0.09:0),z:-0.12};}
export function cargoDamage(kind:CargoKind,deltaVelocity:number,factor=1):number {const p=CARGO_PROFILES[kind];return Math.ceil(p.multiplier*Math.max(0,deltaVelocity*factor-p.threshold)-1e-10);}
export function sanitizeInput(input:unknown):DriveInput {
  const x=input && typeof input==='object' ? input as Partial<DriveInput> : {};
  return {throttle:typeof x.throttle==='number'&&Number.isFinite(x.throttle)?clamp(x.throttle,-1,1):0,steering:typeof x.steering==='number'&&Number.isFinite(x.steering)?clamp(x.steering,-1,1):0,brake:x.brake===true};
}

export class LanePhysics {
  readonly track:TrackDefinition;
  readonly participantId:string;
  readonly blueprint:Blueprint;
  private world:RAPIER.World;
  private chassis:RigidBody;
  private terrainHandle:number;
  private queue:RAPIER.EventQueue;
  private cargoBodies=new Map<string,RigidBody>();
  private cargoColliders=new Map<string,Collider>();
  private state:LaneSnapshot;
  private steering=0;
  private lastRestoreTick=-36;
  private disposed=false;
  private readonly raceLimitTicks:number;

  constructor(options:PhysicsLaneOptions){
    this.raceLimitTicks=options.raceLimitTicks??RACE_TICKS;
    this.blueprint=validateBlueprint(options.blueprint);this.track=structuredClone(options.track);this.participantId=options.participantId??'practice';
    this.queue=new RAPIER.EventQueue(true);
    if(options.snapshot){
      const saved=options.snapshot;this.terrainHandle=saved.terrainHandle??0;this.world=RAPIER.World.restoreSnapshot(decodePhysicsSnapshot(saved.world));
      this.chassis=this.world.getRigidBody(saved.chassisHandle);
      for(const [id,handle] of Object.entries(saved.cargoHandles))this.cargoBodies.set(id,this.world.getRigidBody(handle));
      for(const [id,handle] of Object.entries(saved.cargoColliderHandles))this.cargoColliders.set(id,this.world.getCollider(handle));
      const {world: _world,terrainHandle:_terrain,chassisHandle:_chassis,cargoHandles:_bodies,cargoColliderHandles:_colliders,...state}=saved;
      void _world;void _terrain;void _chassis;void _bodies;void _colliders;
      this.state=structuredClone(state);this.steering=saved.car.wheels[0]?.steering??0;
      this.lastRestoreTick=saved.events.filter(e=>e.kind==='restored').at(-1)?.tick??-36;
      return;
    }
    this.world=new RAPIER.World({x:0,y:-9.81,z:0});this.world.timestep=STEP;
    const terrain=terrainMesh(this.track);
    this.terrainHandle=this.world.createCollider(RAPIER.ColliderDesc.trimesh(terrain.vertices,terrain.indices).setFriction(0.65).setRestitution(0)).handle;
    for(const side of [-1,1])for(let z=-5;z<53;z+=2){const low=groundHeight(this.track,side*3.6,z),high=groundHeight(this.track,side*3.6,z+2);const angle=Math.atan2(high-low,2);this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.12,0.22,Math.hypot(2,high-low)/2).setTranslation(side*3.72,(low+high)/2+0.16,z+1).setRotation({x:-Math.sin(angle/2),y:0,z:0,w:Math.cos(angle/2)}).setFriction(0.25));}
    if(this.track.id==='precision')for(const gate of this.track.orderedGates){
      for(const side of [-1,1]){const edge=gate.x+side*gate.width/2;const wallEdge=side*3.6;const width=Math.abs(wallEdge-edge);this.world.createCollider(RAPIER.ColliderDesc.cuboid(width/2,0.28,0.1).setTranslation((wallEdge+edge)/2,0.28,gate.z).setFriction(0.1).setRestitution(0.05));}
    }
    const radius=(PARTS[this.blueprint['front-axle']].radius!+PARTS[this.blueprint['rear-axle']].radius!)/2;
    const spawn=this.track.spawn;this.chassis=this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(spawn.x,groundHeight(this.track,spawn.x,spawn.z)+radius+0.06,spawn.z).setLinearDamping(0.05).setAngularDamping(1.2).setCcdEnabled(true).setCanSleep(false));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(0.63,0.11,1).setMass(3.2).setFriction(0.4).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0),this.chassis);
    const partPositions:Record<string,Vec3>={'front-axle':{x:0,y:0,z:0.8},'rear-axle':{x:0,y:0,z:-0.8},motor:{x:0,y:0.13,z:0.59},battery:{x:0,y:0.13,z:-0.67},cargo:{x:0,y:0.18,z:-0.12},'aux-left':{x:-0.52,y:-0.08,z:0},'aux-right':{x:0.52,y:-0.08,z:0}};
    for(const [slot,id] of Object.entries(this.blueprint))if(id){const p=partPositions[slot];this.world.createCollider(RAPIER.ColliderDesc.ball(0.04).setTranslation(p.x,p.y,p.z).setMass(PARTS[id as keyof typeof PARTS].mass).setCollisionGroups(0),this.chassis);}
    if([this.blueprint['aux-left'],this.blueprint['aux-right']].includes('rollbar'))for(const x of [-0.48,0.48])this.world.createCollider(RAPIER.ColliderDesc.capsule(0.45,0.04).setTranslation(x,0.35,0).setRotation({x:Math.SQRT1_2,y:0,z:0,w:Math.SQRT1_2}).setMass(0),this.chassis);
    this.world.propagateModifiedBodyPositionsToColliders();
    this.state={tick:0,trackId:this.track.id,mirrored:this.track.mirrored,blueprint:structuredClone(this.blueprint),car:{position:vec(this.chassis.translation()),rotation:quat(this.chassis.rotation()),velocity:vec(ZERO),angularVelocity:vec(ZERO),yaw:0,speed:0,tilt:0,charge:PARTS[this.blueprint.battery].capacity!,wheels:[]},cargo:(options.cargoCount===1?[1]:[0,1,2]).map(slot=>({id:`cargo-${slot+1}`,kind:this.track.cargoKind,status:'at-dock',health:100,slot,position:{x:(slot-1)*0.42,y:0.5,z:this.track.loadingDock.z},rotation:quat(IDENTITY),velocity:vec(ZERO)})),gatesPassed:0,resets:0,unloadTicks:0,tiltTicks:0,finished:false,result:null,events:[],interaction:'none',impactWindowStart:-14,impactWindowPeak:0,impactWindowDamage:0,impactWindowEjected:false,suspensionImpulse:0};
    this.updateState();
  }

  private event(kind:BenchEvent['kind'],extra:Partial<BenchEvent>={}):void {
    const id=`${this.participantId}:${this.track.id}:${this.state.tick}:${kind}:${extra.cargoId??this.state.events.length}`;
    this.state.events.push({id,tick:this.state.tick,kind,position:vec(this.chassis.translation()),...extra});
    if(this.state.events.length>128)this.state.events.shift();
  }
  private shape(kind:CargoKind){return kind==='egg'?RAPIER.ColliderDesc.ball(0.14):RAPIER.ColliderDesc.cuboid(0.14,kind==='power-cell'?0.2:0.14,0.14);}
  private secure(cargo:CargoState):void {
    const body=this.cargoBodies.get(cargo.id);if(body){this.world.removeRigidBody(body);this.cargoBodies.delete(cargo.id);}
    const occupied=new Set(this.state.cargo.filter(c=>c.status==='secured').map(c=>c.slot));cargo.slot=[0,1,2].find(slot=>!occupied.has(slot))??cargo.slot;
    const p=cargoSocket(this.blueprint,cargo.slot);
    this.cargoColliders.set(cargo.id,this.world.createCollider(this.shape(cargo.kind).setTranslation(p.x,p.y,p.z).setMass(CARGO_PROFILES[cargo.kind].mass).setCollisionGroups(0),this.chassis));
    cargo.status='secured';cargo.position=localToWorld(this.chassis,p);cargo.rotation=quat(this.chassis.rotation());cargo.velocity=pointVelocity(this.chassis,cargo.position);
  }
  private release(cargo:CargoState,broken=false):void {
    const collider=this.cargoColliders.get(cargo.id);if(collider){this.world.removeCollider(collider,true);this.cargoColliders.delete(cargo.id);}
    cargo.position=localToWorld(this.chassis,cargoSocket(this.blueprint,cargo.slot));cargo.rotation=quat(this.chassis.rotation());cargo.velocity=pointVelocity(this.chassis,cargo.position);
    const body=this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(cargo.position.x,cargo.position.y,cargo.position.z).setRotation(cargo.rotation).setLinvel(cargo.velocity.x,cargo.velocity.y,cargo.velocity.z).setAngvel(this.chassis.angvel()).setCcdEnabled(true));
    this.world.createCollider(this.shape(cargo.kind).setMass(CARGO_PROFILES[cargo.kind].mass).setFriction(0.8).setRestitution(0.12).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(0),body);
    this.cargoBodies.set(cargo.id,body);cargo.status=broken?'broken':'loose';this.event(broken?'broken':'lost',{cargoId:cargo.id});
  }
  private impact(deltaVelocity:number,cause:string,direction:Vec3):void {
    const module=PARTS[this.blueprint.cargo];const factor=this.blueprint.cargo==='clamp'&&this.state.car.charge<=0?1:module.shockFactor!;
    if(this.state.tick-this.state.impactWindowStart>=14){this.state.impactWindowStart=this.state.tick;this.state.impactWindowPeak=0;this.state.impactWindowDamage=0;this.state.impactWindowEjected=false;}
    if(deltaVelocity<=this.state.impactWindowPeak)return;
    this.state.impactWindowPeak=deltaVelocity;
    const total=cargoDamage(this.track.cargoKind,deltaVelocity,factor);const damage=Math.max(0,total-this.state.impactWindowDamage);this.state.impactWindowDamage=total;
    const secured=this.state.cargo.filter(c=>c.status==='secured');
    for(const cargo of secured){if(damage){const actual=Math.min(cargo.health,damage);cargo.health-=actual;const prior=this.state.events.find(event=>event.kind==='damaged'&&event.cargoId===cargo.id&&event.tick===this.state.impactWindowStart&&event.cause===cause);if(prior)prior.amount=(prior.amount??0)+actual;else this.event('damaged',{cargoId:cargo.id,amount:actual,cause,tick:this.state.impactWindowStart});}if(cargo.health<=0)this.release(cargo,true);}
    if(!this.state.impactWindowEjected&&deltaVelocity*factor>CARGO_PROFILES[this.track.cargoKind].ejection){this.state.impactWindowEjected=true;const edge=selectEjectedCargo(this.state.cargo,this.chassis.rotation(),direction);if(edge)this.release(edge);}
  }
  private updateState():void {
    const car=this.state.car;car.position=vec(this.chassis.translation());car.rotation=quat(this.chassis.rotation());car.velocity=vec(this.chassis.linvel());car.angularVelocity=vec(this.chassis.angvel());
    const forward=rotateVector(car.rotation,{x:0,y:0,z:1});const up=rotateVector(car.rotation,{x:0,y:1,z:0});car.yaw=Math.atan2(forward.x,forward.z);car.speed=Math.hypot(car.velocity.x,car.velocity.y,car.velocity.z);car.tilt=Math.acos(clamp(up.y,-1,1))*180/Math.PI;
    const center=this.chassis.worldCom();
    for(const cargo of this.state.cargo){if(cargo.status==='secured'){cargo.position=add(car.position,rotateVector(car.rotation,cargoSocket(this.blueprint,cargo.slot)));cargo.rotation=quat(car.rotation);cargo.velocity=add(car.velocity,cross(car.angularVelocity,{x:cargo.position.x-center.x,y:cargo.position.y-center.y,z:cargo.position.z-center.z}));}else{const body=this.cargoBodies.get(cargo.id);if(body){cargo.position=vec(body.translation());cargo.rotation=quat(body.rotation());cargo.velocity=vec(body.linvel());}}}
    this.state.interaction=this.interaction();
  }
  private interaction():LaneSnapshot['interaction'] {
    if(this.state.finished)return 'none';
    const secured=this.state.cargo.filter(c=>c.status==='secured');if(secured.length===3)return 'full';
    const car=this.state.car;const module=add(car.position,rotateVector(car.rotation,cargoSocket(this.blueprint,1)));const dock=this.track.loadingDock;
    const nearDock=Math.hypot(module.x-dock.x,module.y-(groundHeight(this.track,dock.x,dock.z)+0.5),module.z-dock.z)<=dock.radius;
    const loose=this.state.cargo.some(c=>c.status==='loose'&&c.health>0&&Math.hypot(module.x-c.position.x,module.y-c.position.y,module.z-c.position.z)<=0.9);
    if(!nearDock&&!loose)return 'none';
    if(car.speed>0.7)return 'slow-down';
    if(loose)return 'pickup';
    if(this.state.cargo.some(c=>c.status==='at-dock'))return Math.abs(Math.atan2(Math.sin(car.yaw),Math.cos(car.yaw)))>Math.PI/6?'face-dock':'load';
    return 'empty';
  }
  interact():boolean {
    this.updateState();const action=this.state.interaction;
    if(action==='load'){for(const cargo of this.state.cargo.filter(c=>c.status==='at-dock').sort((a,b)=>a.id.localeCompare(b.id))){this.secure(cargo);this.event('loaded',{cargoId:cargo.id});}this.updateState();return true;}
    if(action==='pickup'){const p=localToWorld(this.chassis,cargoSocket(this.blueprint,1));const candidates=this.state.cargo.filter(c=>c.status==='loose'&&c.health>0&&Math.hypot(p.x-c.position.x,p.y-c.position.y,p.z-c.position.z)<=0.9).sort((a,b)=>Math.hypot(p.x-a.position.x,p.y-a.position.y,p.z-a.position.z)-Math.hypot(p.x-b.position.x,p.y-b.position.y,p.z-b.position.z)||a.id.localeCompare(b.id));if(candidates[0]){this.secure(candidates[0]);this.event('picked-up',{cargoId:candidates[0].id});this.updateState();return true;}}
    return false;
  }
  restore():void {
    if(this.state.finished||this.state.tick-this.lastRestoreTick<36)return;
    const pad=this.track.restorePads[Math.min(this.state.gatesPassed,this.track.restorePads.length-1)];const radius=(PARTS[this.blueprint['front-axle']].radius!+PARTS[this.blueprint['rear-axle']].radius!)/2;
    this.chassis.setTranslation({x:pad.x,y:groundHeight(this.track,pad.x,pad.z)+radius+0.08,z:pad.z},true);this.chassis.setRotation({x:0,y:Math.sin(pad.yaw/2),z:0,w:Math.cos(pad.yaw/2)},true);this.chassis.setLinvel(ZERO,true);this.chassis.setAngvel(ZERO,true);this.chassis.resetForces(true);this.chassis.resetTorques(true);
    this.state.resets++;this.state.tiltTicks=0;this.state.unloadTicks=0;this.lastRestoreTick=this.state.tick;this.event('restored');this.updateState();
  }
  /** Advances the authoritative state without allocating a transport copy. */
  advance(rawInput:DriveInput):void {
    if(this.disposed)throw new Error('Disposed physics lane');
    if(this.state.finished)return;
    const input=sanitizeInput(rawInput);this.state.tick++;
    const previous=vec(this.chassis.translation());const previousVelocity=vec(this.chassis.linvel());const rotation=this.chassis.rotation();const up=rotateVector(rotation,{x:0,y:1,z:0});const forward=rotateVector(rotation,{x:0,y:0,z:1});const right=rotateVector(rotation,{x:1,y:0,z:0});
    const signedSpeed=dot(this.chassis.linvel(),forward);const motor=PARTS[this.blueprint.motor];const car=this.state.car;
    const requestedAngle=input.steering*(33-16*clamp(Math.abs(signedSpeed)/motor.maxSpeed!,0,1))*Math.PI/180;
    this.steering+=clamp(requestedAngle-this.steering,-STEP*2.8,STEP*2.8);
    this.chassis.resetForces(true);this.chassis.resetTorques(true);
    let throttle=input.throttle;let braking=input.brake;
    if(throttle<0&&signedSpeed>0.45){braking=true;throttle=0;}
    if(car.charge<=0)throttle=0;
    const auxiliaries=[this.blueprint['aux-left'],this.blueprint['aux-right']];const mass=this.chassis.mass();
    car.wheels=[];let suspensionCollisionImpulse=0;const center=this.chassis.worldCom();const inverseMass=this.chassis.invMass();let inertia:ReturnType<RigidBody['effectiveWorldInvInertia']>|undefined;
    for(const z of [0.8,-0.8])for(const x of [-0.8,0.8]){
      const front=z>0;const axle=PARTS[this.blueprint[front?'front-axle':'rear-axle']];const radius=axle.radius!;const damper=auxiliaries.includes(front?'damper-front':'damper-rear');const travel=0.13+(damper?0.07:0);
      const mount=add(previous,rotateVector(rotation,{x,y:0,z}));const ray=new RAPIER.Ray(mount,{x:0,y:-1,z:0});const hit=up.y>0.1?this.world.castRayAndGetNormal(ray,radius+travel,true,RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,undefined,undefined,undefined,collider=>collider.handle===this.terrainHandle):null;
      let compression=0;let wheelY=-travel;
      if(hit){compression=clamp(travel-(hit.timeOfImpact-radius),0,travel);wheelY=radius-hit.timeOfImpact;const point=ray.pointAt(hit.timeOfImpact);const velocity=pointVelocity(this.chassis,mount,center);const load=Math.max(0,235*compression-24*(damper?1.25:1)*velocity.y);
        this.chassis.addForceAtPoint(scale(hit.normal,load),mount,true);
        // The spring cannot retract past its physical travel. A bottomed wheel
        // transfers a real normal impulse through the chassis at its mount.
        const penetration=Math.max(0,radius-hit.timeOfImpact);
        if(penetration>0){const stopVelocity=Math.max(0,penetration/STEP*0.35-dot(velocity,hit.normal));const arm={x:mount.x-center.x,y:mount.y-center.y,z:mount.z-center.z};const rotational=cross(arm,hit.normal);inertia??=this.chassis.effectiveWorldInvInertia();const response={x:inertia.m11*rotational.x+inertia.m12*rotational.y+inertia.m13*rotational.z,y:inertia.m21*rotational.x+inertia.m22*rotational.y+inertia.m23*rotational.z,z:inertia.m31*rotational.x+inertia.m32*rotational.y+inertia.m33*rotational.z};const effectiveMass=1/(inverseMass+dot(rotational,response));const impulse=stopVelocity*effectiveMass;this.chassis.applyImpulseAtPoint(scale(hit.normal,impulse),mount,true);suspensionCollisionImpulse+=impulse/Math.max(mass,0.1);}
        const angle=front?this.steering:0;const wheelForward=add(scale(forward,Math.cos(angle)),scale(right,Math.sin(angle)));const wheelRight=add(scale(right,Math.cos(angle)),scale(forward,-Math.sin(angle)));
        const wet=isWet(this.track,point.x,point.z);const {lateral,longitudinal}=axleGrip(this.blueprint[front?'front-axle':'rear-axle'],wet);
        let lateralForce=clamp(-dot(velocity,wheelRight)*mass*3.5,-load*lateral,load*lateral);
        const normal=hit.normal;const slopeForward=dot(wheelForward,normal);const tangentForward={x:wheelForward.x-normal.x*slopeForward,y:wheelForward.y-normal.y*slopeForward,z:wheelForward.z-normal.z*slopeForward};
        let longitudinalForce=-clamp(dot(velocity,wheelForward)*load*0.025,-load*0.025,load*0.025);
        if(!front){const limit=throttle<0?2:motor.maxSpeed!;const fade=clamp((limit-Math.abs(signedSpeed))/(limit*0.12),0,1);longitudinalForce+=throttle*motor.force!*0.5*fade;}
        if(braking){const v=dot(velocity,wheelForward);longitudinalForce=-clamp(v*mass*5,-55/4,55/4);lateralForce=clamp(lateralForce*1.3,-load*lateral,load*lateral);}
        longitudinalForce=clamp(longitudinalForce,-load*longitudinal,load*longitudinal);
        this.chassis.addForceAtPoint(add(scale(tangentForward,longitudinalForce),scale(wheelRight,lateralForce)),mount,true);
      }
      car.wheels.push({x,y:wheelY,z,radius,compression,steering:front?this.steering:0,grounded:!!hit});
    }
    const clamping=this.blueprint.cargo==='clamp'&&this.state.cargo.some(c=>c.status==='secured');const consumption=(Math.abs(throttle)*motor.consumption!+(clamping?0.28:0))*STEP;
    if(car.charge>0){car.charge=Math.max(0,car.charge-consumption);if(car.charge===0)this.event('depleted');}
    this.world.step(this.queue);
    let collisionImpulse=0;
    const looseImpulses=new Map<string,number>();
    this.queue.drainContactForceEvents(event=>{
      const a=this.world.getCollider(event.collider1()),b=this.world.getCollider(event.collider2());const impulse=event.totalForceMagnitude()*STEP;
      if(a?.parent()?.handle===this.chassis.handle||b?.parent()?.handle===this.chassis.handle)collisionImpulse=Math.max(collisionImpulse,impulse/Math.max(mass,0.1));
      for(const [id,body] of this.cargoBodies)if(a?.parent()?.handle===body.handle||b?.parent()?.handle===body.handle)looseImpulses.set(id,Math.max(looseImpulses.get(id)??0,impulse/CARGO_PROFILES[this.track.cargoKind].mass));
    });
    const velocity=this.chassis.linvel();const verticalChange=velocity.y-previousVelocity.y;
    // A wheel contact acts over several fixed steps. Integrate the rising
    // normal velocity into one impact, rather than treating every substep as
    // an independent tiny impulse below the cargo threshold.
    if(verticalChange>0.002)this.state.suspensionImpulse+=verticalChange;
    else if(verticalChange< -0.002)this.state.suspensionImpulse=0;
    const verticalImpulse=Math.max(this.state.suspensionImpulse,suspensionCollisionImpulse);
    this.impact(Math.max(collisionImpulse,verticalImpulse),'impact',{x:previousVelocity.x-velocity.x,y:previousVelocity.y-velocity.y,z:previousVelocity.z-velocity.z});
    for(const [id,impulse] of looseImpulses){const cargo=this.state.cargo.find(c=>c.id===id)!;if(cargo.status!=='loose')continue;const damage=Math.min(cargo.health,cargoDamage(cargo.kind,impulse));if(damage){cargo.health-=damage;this.event('damaged',{cargoId:id,amount:damage,cause:'ground'});if(cargo.health===0){cargo.status='broken';this.event('broken',{cargoId:id});}}}
    this.updateState();
    const tiltLimit=this.blueprint.cargo==='clamp'&&car.charge<=0?37:PARTS[this.blueprint.cargo].tiltLimit!;
    this.state.tiltTicks=car.tilt>tiltLimit?this.state.tiltTicks+1:0;
    if(this.state.tiltTicks>21)for(const cargo of this.state.cargo.filter(c=>c.status==='secured'))this.release(cargo);
    while(this.state.gatesPassed<this.track.orderedGates.length&&crossedGate(previous,car.position,this.track.orderedGates[this.state.gatesPassed])){this.state.gatesPassed++;this.event('gate',{gate:this.state.gatesPassed});}
    if(Math.abs(car.position.x)>6||car.position.z< -5||car.position.z>55||car.position.y< -3)this.restore();
    const unload=this.track.unload;const inside=car.position.x>=unload.minX&&car.position.x<=unload.maxX&&car.position.z>=unload.minZ&&car.position.z<=unload.maxZ;
    const secured=this.state.cargo.filter(c=>c.status==='secured'&&c.health>0);
    this.state.unloadTicks=inside&&car.speed<=0.6&&this.state.gatesPassed===this.track.orderedGates.length&&secured.length>0?this.state.unloadTicks+1:0;
    if(this.state.unloadTicks>=30){this.state.finished=true;this.state.result={participantId:this.participantId,delivered:secured.length,integrity:secured.reduce((sum,c)=>sum+c.health,0),elapsedTicks:this.state.tick+300*this.state.resets,resets:this.state.resets,finished:true};for(const cargo of secured){cargo.status='deposited';const collider=this.cargoColliders.get(cargo.id);if(collider){this.world.removeCollider(collider,true);this.cargoColliders.delete(cargo.id);}}this.event('delivered',{amount:secured.length});}
    if(this.state.tick>=this.raceLimitTicks&&!this.state.finished){this.state.finished=true;this.state.result={participantId:this.participantId,delivered:0,integrity:0,elapsedTicks:this.raceLimitTicks+300*this.state.resets,resets:this.state.resets,finished:false};this.event('timeout');}
    this.state.interaction=this.interaction();
  }
  step(rawInput:DriveInput):LaneSnapshot {this.advance(rawInput);return this.snapshot();}
  /** In-process read only view; use snapshot() when handing data to callers. */
  observe():Readonly<LaneSnapshot>{return this.state;}
  snapshot():LaneSnapshot{return structuredClone(this.state);}
  checkpoint():LaneCheckpoint {return {...this.snapshot(),world:encodePhysicsSnapshot(this.world.takeSnapshot()),terrainHandle:this.terrainHandle,chassisHandle:this.chassis.handle,cargoHandles:Object.fromEntries([...this.cargoBodies].map(([id,body])=>[id,body.handle])),cargoColliderHandles:Object.fromEntries([...this.cargoColliders].map(([id,c])=>[id,c.handle]))};}
  dispose():void {if(this.disposed)return;this.disposed=true;this.queue.free();this.world.free();}
}
export async function createPhysicsLane(options:PhysicsLaneOptions):Promise<LanePhysics>{await initPhysics();return new LanePhysics(options);}
export function vehicleMass(lane:LaneSnapshot):number{return blueprintMass(lane.blueprint)+lane.cargo.filter(c=>c.status==='secured').reduce((sum,c)=>sum+CARGO_PROFILES[c.kind].mass,0);}
