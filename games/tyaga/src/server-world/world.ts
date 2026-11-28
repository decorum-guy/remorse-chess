import RAPIER from '@dimforge/rapier3d-compat';
import type { Collider, RigidBody } from '@dimforge/rapier3d-compat';
import { BODY, CONTENT_VERSION, DT, FRICTION, NEUTRAL_INPUT, PHYSICS, RULES_VERSION, normalizeInput } from '../core/config';
import { add, angleDifference, clamp, conjugate, cross, distance, dot, length, localPoint, mix, mul, norm, Q, quatAxis, quatMul, rotate, sub, V, worldPoint, yaw, yawQuat } from '../core/math';
import type { ActionResult, ControllerState, EntityView, MapZone, MaterialId, SocketView, TyagaInput, TyagaMap, TyagaView, Vec3, WorldOptions } from '../core/types';
import { getMap, validateMap } from '../maps';
import { socketsFor } from './objects';
import type { BodyOptions, EntityRecord, GameState, LinkRecord, SavedWorld } from './state';
import { performAction, finishOperation, interactionsFor, zoneConditions } from './actions';
import { chooseBotAction } from '../bots';
import { advanceTutorial, tutorialView } from '../tutorial';
import { bridgeMountParts, deckParts } from './compound';

export const PHYSICS_BUILD_HASH = 'rapier3d-0.21.0:17cfa80eebd8de0291b948496dbffba724b98b489687f8272ca236a7bbf1dd4b:tyaga-solver-12-4-rope64-v9';
let initialization: Promise<void> | undefined;
export function initializePhysics(): Promise<void> { return initialization ??= RAPIER.init().then(()=>{if(RAPIER.version()!=='0.21.0')throw new Error(`INCOMPATIBLE_RAPIER_RUNTIME:${RAPIER.version()}`);}); }
export class TyagaWorld {
  readonly map: TyagaMap;
  physics: RAPIER.World;
  state: GameState;
  readonly queue: RAPIER.EventQueue;
  inputs: Record<string, TyagaInput> = {};
  private warming = false;

  private constructor(physics: RAPIER.World, state: GameState) {
    this.physics = physics; this.state = state; this.map = getMap(state.mapId); this.queue = new RAPIER.EventQueue(true);
  }
  static async create(options: WorldOptions): Promise<TyagaWorld> {
    await initializePhysics();
    if (options.participants.length < 2 || options.participants.length > 6 || new Set(options.participants.map(p => p.participantId)).size !== options.participants.length) throw new Error('INVALID_PARTICIPANTS');
    const map=getMap(options.mapId);const errors=validateMap(map);if(errors.length)throw new Error(errors.join('; '));
    const physics=new RAPIER.World(V(0,-PHYSICS.gravity,0));physics.timestep=DT;
    physics.integrationParameters.numSolverIterations=12;
    physics.integrationParameters.numInternalPgsIterations=4;
    physics.integrationParameters.maxCcdSubsteps=4;
    const fixed=physics.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const state:GameState={schema:1,matchId:options.matchId,mapId:options.mapId,mode:options.mode??(options.mapId==='tutorial'?'tutorial':'expedition'),tick:0,worldTime:0,elapsedSeconds:0,rewinds:0,phase:'running',entities:{},characters:{},inventory:{},links:{},operations:{},fixedBodyHandle:fixed.handle,colliderBodies:{},colliderMaterials:{},truck:{driver:null,brake:true,brakeHolder:null,wheels:[],grips:[],engineSubmerged:0},vote:null,voteCooldown:0,checkpointId:'start',zoneReadySeconds:{},outcome:null,events:[],nextEventId:1,nextLinkId:1,machinery:{ferry:null,lift:null,jacks:{}},contactCooldown:{},previousVelocities:{},tutorial:{step:0,completed:false,flags:{},stepStartPosition:map.start,stepStartedAt:0,checkpointDone:false},pendingCheckpointId:null,initialParticipantIds:options.participants.map(p=>p.participantId)};
    const world=new TyagaWorld(physics,state);world.initializeTerrain();world.initializeCargo();
    for(const [index,participant]of options.participants.entries()){
      const spawn=add(map.start,V(1.8-(Math.floor(index/2)*1.7),.9,(index%2? -1:1)*2.8));
      const id=`person:${participant.participantId}`;world.addBody({id,kind:'character',position:spawn});
      const controller:ControllerState={participantId:participant.participantId,kind:participant.bot?'bot':'human',connected:!participant.bot,controllerGeneration:0};
      state.characters[participant.participantId]={participant,controller,bodyId:id,controlling:null,holding:null,heading:0,grounded:false,groundBodyId:null,safePoint:spawn,safeTime:0,rescueAt:null,rescueCooldown:0,stuckFor:0,submergedFor:0,seatJoint:null,lastPosition:spawn,jumpTick:-100,task:participant.bot?{kind:'follow',status:'following',failures:0,failedAt:0}:null,botMemory:{nextActionAt:0,lastPosition:spawn,stuckFor:0,lastJumpAt:-100}};
    }
    world.initializeMechanisms();world.updateMasses();physics.propagateModifiedBodyPositionsToColliders();
    // Starting placements settle under the same gravity, contacts and springs.
    // No body is pinned to its spawn transform during play.
    world.warming=true;for(let i=0;i<90;i++)world.physicsStep();world.warming=false;
    state.tick=0;state.worldTime=0;state.elapsedSeconds=0;state.events=[];state.nextEventId=1;
    for(const c of Object.values(state.characters)){c.safePoint={...world.body(c.bodyId).translation()};c.lastPosition={...c.safePoint};}
    world.state.tutorial.stepStartPosition={...world.body(state.characters[options.participants[0].participantId].bodyId).translation()};
    return world;
  }
  static async restore(serialized: string): Promise<TyagaWorld> {
    await initializePhysics();const value=JSON.parse(serialized) as SavedWorld;
    if(value.schema!==1||value.physicsBuildHash!==PHYSICS_BUILD_HASH||value.state.schema!==1)throw new Error('INCOMPATIBLE_PHYSICS_SNAPSHOT');
    const physics=RAPIER.World.restoreSnapshot(new Uint8Array(Buffer.from(value.physics,'base64')));
    const world=new TyagaWorld(physics,value.state);
    for(const record of Object.values(value.state.entities))if(record.active&&!physics.getRigidBody(record.handle))throw new Error('CORRUPT_BODY_MAP');
    physics.propagateModifiedBodyPositionsToColliders();return world;
  }
  serialize(): string {return JSON.stringify({schema:1,physicsBuildHash:PHYSICS_BUILD_HASH,physics:Buffer.from(this.physics.takeSnapshot()).toString('base64'),state:this.state} satisfies SavedWorld);}
  dispose(): void {this.queue.free();this.physics.free();}
  body(id: string): RigidBody {const e=this.state.entities[id];if(!e?.active)throw new Error('UNKNOWN_BODY');const b=this.physics.getRigidBody(e.handle);if(!b)throw new Error('MISSING_BODY');return b;}
  maybeBody(id: string): RigidBody|null {const e=this.state.entities[id];return e?.active?this.physics.getRigidBody(e.handle):null;}
  emit(type:string,entityId?:string,participantId?:string,amount?:number,message?:{ru:string;en:string}):void {this.state.events.push({id:this.state.nextEventId++,type,tick:this.state.tick,...(entityId?{entityId}:{}),...(participantId?{participantId}:{}),...(amount!==undefined?{amount}:{}),...(message?{message}:{})});if(this.state.events.length>80)this.state.events.splice(0,this.state.events.length-80);}
  private initializeTerrain():void {
    const fixed=this.physics.getRigidBody(this.state.fixedBodyHandle);
    for(const shape of this.map.surfaces){const geometry=shape.mesh?RAPIER.ColliderDesc.trimesh(new Float32Array(shape.mesh.vertices),new Uint32Array(shape.mesh.indices),RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES):RAPIER.ColliderDesc.cuboid(shape.size.x/2,shape.size.y/2,shape.size.z/2);const d=geometry.setTranslation(shape.position.x,shape.position.y,shape.position.z).setRotation(shape.rotation).setFriction(FRICTION[shape.material]).setRestitution(.02);const collider=this.physics.createCollider(d,fixed);this.state.colliderBodies[collider.handle]=`surface:${shape.id}`;this.state.colliderMaterials[collider.handle]=shape.material;}
    for(const anchor of this.map.anchors){const e=this.addBody({id:anchor.id,kind:'ring',position:anchor.position,fixed:true,...(anchor.mount==='deck'?{customModel:'bridge-mount',size:V(.36,.28+.152*80/93,.36)}:{})});e.anchorLimit=anchor.limit;}
  }
  addBody(options:BodyOptions):EntityRecord{
    const p=BODY[options.kind];const size=options.size??p.size;const q=options.rotation??Q();
    const desc=(options.fixed?RAPIER.RigidBodyDesc.fixed():RAPIER.RigidBodyDesc.dynamic()).setTranslation(options.position.x,options.position.y,options.position.z).setRotation(q);
    if(!options.fixed){desc.setCcdEnabled(true).setLinearDamping(options.kind==='rope-segment'? .3:.08).setAngularDamping(options.kind==='character'?2:.2).setAdditionalSolverIterations(options.kind==='rope-segment'||options.kind==='hook'?64:4);if(options.kind==='character')desc.lockRotations();}
    const body=this.physics.createRigidBody(desc);const colliders:number[]=[];
    const mass=options.mass??p.mass;
    const makeCollider=(d:RAPIER.ColliderDesc,partMass:number)=>{d.setMass(options.fixed?0:partMass).setFriction(options.kind==='character'?.08:options.kind==='deck'?.8:options.kind==='rope-segment'?.12:.55).setRestitution(.015).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(20);if(options.kind==='rope-segment')d.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);const c=this.physics.createCollider(d,body);colliders.push(c.handle);this.state.colliderBodies[c.handle]=options.id;this.state.colliderMaterials[c.handle]=options.kind==='deck'?'wood':'steel';};
    if(options.kind==='truck'){
      makeCollider(RAPIER.ColliderDesc.cuboid(2.65,.075,1.2).setTranslation(-.4,.275,0),mass*.55);
      makeCollider(RAPIER.ColliderDesc.cuboid(.48,.64,1.1).setTranslation(2.7,.62,0),mass*.24);
      for(const z of [-1,1])makeCollider(RAPIER.ColliderDesc.cuboid(2.9,.08,.1).setTranslation(-.2,-.32,z*1.2),mass*.07);
      makeCollider(RAPIER.ColliderDesc.cuboid(2.5,.07,1.1).setTranslation(-.3,-.37,0),mass*.07);
      const main=this.map.cargo[0];const high=main==='mast'?1.15:.15;
      for(const x of main==='mast'?[-1.6,1.6]:[-1.9,.5])makeCollider(RAPIER.ColliderDesc.cuboid(.15,high/2,.9).setTranslation(x,.35+high/2,0),0);
    }else if(options.kind==='ring'&&options.customModel==='bridge-mount'){
      for(const descriptor of bridgeMountParts())makeCollider(descriptor,0);
    }else if(options.kind==='deck'&&!options.folded){
      const parts=deckParts(),volume=parts.reduce((sum,part)=>sum+part.volume,0);
      for(const part of parts)makeCollider(part.descriptor,mass*part.volume/volume);
    }else if(options.kind==='jack'){
      makeCollider(RAPIER.ColliderDesc.cuboid(.25,.12,.18).setTranslation(0,-.24,0),mass*.7);
      makeCollider(RAPIER.ColliderDesc.cuboid(.08,.18,.08).setTranslation(0,-.05,0),mass*.25);
      makeCollider(RAPIER.ColliderDesc.cuboid(.02,.23,.02).setTranslation(.28,.13,0),mass*.05);
    }else if(options.kind==='drive'){
      // The engine, submerged leg and mounting clamp have distinct volumes.
      // A solid bounding box would prevent the outboard clamp reaching a deck.
      makeCollider(RAPIER.ColliderDesc.cuboid(.425,.275,.25).setTranslation(0,.32,0),mass*.65);
      makeCollider(RAPIER.ColliderDesc.cuboid(.065,.325,.065).setTranslation(-.255,-.22,0),mass*.2);
      makeCollider(RAPIER.ColliderDesc.cuboid(.075,.167,.3).setTranslation(-.255,-.433,0),mass*.1);
      makeCollider(RAPIER.ColliderDesc.cuboid(.05,.05,.075).setTranslation(.55,.55,0),mass*.05);
    }else if(options.kind==='character')makeCollider(RAPIER.ColliderDesc.capsule((PHYSICS.characterHeight-2*PHYSICS.characterRadius)/2,PHYSICS.characterRadius),mass);
    else if(options.kind==='ferry-deck'||options.kind==='lift'){
      makeCollider(RAPIER.ColliderDesc.cuboid(size.x/2,size.y/2,size.z/2),mass);
      for(const z of [-2.04,2.04]){makeCollider(RAPIER.ColliderDesc.cuboid(4,.04,.04).setTranslation(0,.95,z),0);for(const x of [-3.2,0,3.2])makeCollider(RAPIER.ColliderDesc.cuboid(.04,.375,.04).setTranslation(x,.575,z),0);}
    }else if(options.kind==='rope-segment')makeCollider(RAPIER.ColliderDesc.capsule(Math.max(.001,size.y/2-.04),.04),mass);
    else makeCollider(RAPIER.ColliderDesc.cuboid(size.x/2,size.y/2,size.z/2),mass);
    const e:EntityRecord={id:options.id,kind:options.kind,handle:body.handle,colliders,size:{...size},baseMass:mass,sockets:socketsFor(options.kind,size),required:options.required??false,active:true,fixed:options.fixed??false,submergedSeconds:0,lastSafe:{...options.position},...(options.integrity!==undefined?{integrity:options.integrity}:{}),...(options.folded?{folded:true}:{}),...(options.customModel?{customModel:options.customModel}:{})};
    this.state.entities[options.id]=e;return e;
  }
  removeBody(id:string):void{const e=this.state.entities[id];if(!e?.active)return;for(const h of e.colliders){delete this.state.colliderBodies[h];delete this.state.colliderMaterials[h];}const b=this.physics.getRigidBody(e.handle);if(b)this.physics.removeRigidBody(b);e.active=false;}
  unfoldDeckGeometry(id:string):void{
    const e=this.state.entities[id],body=this.body(id),mass=body.mass();
    for(const handle of e.colliders){this.physics.removeCollider(this.physics.getCollider(handle),true);delete this.state.colliderBodies[handle];delete this.state.colliderMaterials[handle];}
    e.colliders=[];const parts=deckParts(),volume=parts.reduce((sum,part)=>sum+part.volume,0);
    for(const part of parts){const collider=this.physics.createCollider(part.descriptor.setMass(mass*part.volume/volume).setFriction(.8).setRestitution(.015).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(20),body);e.colliders.push(collider.handle);this.state.colliderBodies[collider.handle]=id;this.state.colliderMaterials[collider.handle]='wood';}
    body.recomputeMassPropertiesFromColliders();
  }
  private initializeCargo():void{
    const p=this.map.start;this.addBody({id:'truck',kind:'truck',position:add(p,V(0,.98,0)),mass:1000,integrity:100,required:true});
    this.addBody({id:'equipment-crate',kind:'crate',position:add(p,V(-.3,.93,0))});
    for(const [kind,count]of Object.entries(this.map.tools))for(let i=0;i<count;i++){const k=kind as keyof TyagaMap['tools'];const profile=BODY[k];const id=`${kind}-${i+1}`;this.state.inventory[id]={id,kind:k,name:profile.name,mass:profile.mass,state:'stored'};}
    const base=this.body('truck').translation();
    for(const [i,kind]of this.map.cargo.entries()){
      const size=BODY[kind].size;const main=i===0;const mast=this.map.cargo[0]==='mast';
      const local=main?V(mast?0:-.65,.35+(mast?1.15:.15)+size.y/2+.015,0):mast?V(i===1?-.7:.7,.35+size.y/2+.01,0):V(1.7,.35+size.y/2+.01,i===1?-.6:.6);
      const id=`cargo-${i+1}`;this.addBody({id,kind,position:add(base,local),required:true,integrity:100});
      const cargoSockets=this.state.entities[id].sockets.filter(s=>s.role==='ring'&&s.id!=='top-ring');
      const chosen=main?cargoSockets:cargoSockets.filter(s=>Math.sign(s.local.z)===(mast?(i===1?-1:1):i===1?-1:1));
      for(const socket of chosen){const target=this.closestSocket('truck',this.socket(id,socket.id)!.world,'ring');if(target){const item=Object.values(this.state.inventory).find(v=>v.kind==='strap'&&v.state==='stored');if(item)this.addLink('strap',id,socket.id,'truck',target.id,item.id);}}
    }
    for(const socket of this.state.entities['equipment-crate'].sockets.filter(s=>s.role==='ring')){const target=this.closestSocket('truck',this.socket('equipment-crate',socket.id)!.world,'ring')!;const item=Object.values(this.state.inventory).find(v=>v.kind==='strap'&&v.state==='stored');if(item)this.addLink('strap','equipment-crate',socket.id,'truck',target.id,item.id);}
    for(const start of this.map.startBodies){const e=this.addBody({...start});if(['drive','beam','repair','anchor','deck'].includes(e.kind)){const k=e.kind as 'drive'|'beam'|'repair'|'anchor'|'deck';this.state.inventory[e.id]={id:e.id,kind:k,name:BODY[k].name,mass:e.baseMass,state:'world',bodyId:e.id};}}
  }
  private initializeMechanisms():void{
    if(this.map.id==='quarry'){
      const supports:number[]=[];
      for(const x of [40,46])for(const z of [62.3,65.7]){const b=this.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x,-2.8,z));const c=this.physics.createCollider(RAPIER.ColliderDesc.cuboid(.22,.3,.22),b);this.state.colliderBodies[c.handle]='ferry-support';supports.push(b.handle);}
      this.state.machinery.ferry={launched:false,driveId:null,supportHandles:supports,operator:null,propellerAngle:0};
      for(const [rampId,dockX,dockY]of [['near-ramp',36,-2.71],['far-ramp',84.1,-2.8]]as const){const body=this.body(rampId);const fixed=this.physics.getRigidBody(this.state.fixedBodyHandle);const local=localPoint(body.translation(),body.rotation(),V(dockX,dockY,64));const joint=RAPIER.JointData.revolute(V(dockX,dockY,64),local,V(0,0,1));const j=this.physics.createImpulseJoint(joint,fixed,body,true);j.setContactsEnabled(true);}
    }
    if(this.map.id==='ridge'){
      const fixed=this.physics.getRigidBody(this.state.fixedBodyHandle);const platform=this.body('lift-platform');
      const data=RAPIER.JointData.prismatic(V(222,10.1,72),V(),V(0,1,0));data.limitsEnabled=true;data.limits=[0,6];
      const guide=this.physics.createImpulseJoint(data,fixed,platform,true);guide.setContactsEnabled(true);
      this.state.machinery.lift={driveId:null,targetHeight:10.1,operator:null,guideJoint:guide.handle,cableBroken:false,catchHeight:null,barriers:{'lift-barrier-near':false,'lift-barrier-far':false},driveJoint:null,overloadSeconds:0};
      for(const id of ['lift-barrier-near','lift-barrier-far']){const b=this.body(id);const local=localPoint(platform.translation(),platform.rotation(),b.translation());const j=this.physics.createImpulseJoint(RAPIER.JointData.fixed(local,Q(),V(),Q()),platform,b,true);j.setContactsEnabled(false);this.physics.getCollider(this.state.entities[id].colliders[0]).setCollisionGroups(0x00010000);}
      this.addBody({id:'lift-transmission',kind:'ring',position:V(222,17.25,69.3),fixed:true});this.state.entities['lift-transmission'].sockets=[{id:'drive',local:V(),role:'drive'},{id:'control',local:V(0,-.4,0),role:'control'}];
      this.addBody({id:'lift-lower-control',kind:'ring',position:V(216,10.8,74),fixed:true});this.state.entities['lift-lower-control'].sockets=[{id:'control',local:V(),role:'control'}];
    }
  }
  socket(id:string,socketId:string):SocketView|null{
    const e=this.state.entities[id];if(!e?.active)return null;const s=e.sockets.find(s=>s.id===socketId);if(!s)return null;const b=this.body(id);let occupiedBy=s.occupiedBy;
    for(const c of Object.values(this.state.characters))if(c.holding?.itemId===id&&c.holding.handleId===socketId)occupiedBy=c.participant.participantId;
    for(const link of Object.values(this.state.links))if(!link.broken&&!link.detached&&link.kind!=='strap'&&((link.fromId===id&&link.fromSocket===socketId)||(link.toId===id&&link.toSocket===socketId)))occupiedBy=link.id;
    return {...s,...(occupiedBy?{occupiedBy}:{}),world:worldPoint(b.translation(),b.rotation(),s.local)};
  }
  closestSocket(id:string,point:Vec3,role?:SocketView['role']):SocketView|null{const e=this.state.entities[id];if(!e?.active)return null;return e.sockets.filter(s=>!role||s.role===role).map(s=>this.socket(id,s.id)!).sort((a,b)=>distance(a.world,point)-distance(b.world,point))[0]??null;}
  pointVelocity(body:RigidBody,point:Vec3):Vec3{return add(body.linvel(),cross(body.angvel(),sub(point,body.worldCom())));}
  bodyPoint(id:string,local:Vec3):Vec3{const b=this.body(id);return worldPoint(b.translation(),b.rotation(),local);}
  canReach(participantId:string,id:string,socketId?:string,range:number=PHYSICS.interact,consumedItemId?:string):{ok:boolean;distance:number;code:string}{
    const c=this.state.characters[participantId];const e=this.state.entities[id];if(!c||!e?.active)return{ok:false,distance:Infinity,code:'NOT_FOUND'};
    const actor=this.body(c.bodyId);const chest=add(actor.translation(),V(0,.25,0));
    const socket=socketId?this.socket(id,socketId):this.closestSocket(id,chest);const target=socket?.world??this.body(id).translation();
    const d=distance(chest,target);if(d>range)return{ok:false,distance:d,code:'TOO_FAR'};
    const ray=new RAPIER.Ray(chest,norm(sub(target,chest)));
    const hit=this.physics.castRay(ray,Math.max(0,d-.08),true,undefined,undefined,undefined,actor,collider=>{const eid=this.state.colliderBodies[collider.handle];return (collider.collisionGroups()&0xffff)!==0&&eid!==id&&eid!==c.bodyId&&(consumedItemId===undefined||eid!==consumedItemId)&&!eid?.startsWith('rope:');});
    if(hit)return{ok:false,distance:d,code:'BLOCKED'};return{ok:true,distance:d,code:'OK'};
  }
  ground(position:Vec3,max=4,excludeId?:string):{point:Vec3;normal:Vec3;bodyId:string|null;material:MaterialId;collider:Collider}|null{
    const origin=add(position,V(0,.1,0));const ray=new RAPIER.Ray(origin,V(0,-1,0));const body=excludeId?this.maybeBody(excludeId):undefined;
    const hit=this.physics.castRayAndGetNormal(ray,max,true,undefined,undefined,undefined,body??undefined,c=>(c.collisionGroups()&0xffff)!==0&&this.state.entities[this.state.colliderBodies[c.handle]]?.kind!=='rope-segment');
    if(!hit)return null;return{point:add(origin,V(0,-hit.timeOfImpact,0)),normal:{...hit.normal},bodyId:this.state.colliderBodies[hit.collider.handle]??null,material:(this.state.colliderMaterials[hit.collider.handle]??'soil')as MaterialId,collider:hit.collider};
  }
  private characterSupport(id:string):ReturnType<TyagaWorld['ground']>{
    const c=this.state.characters[id],body=this.body(c.bodyId),p=body.translation(),minimumNormal=Math.cos(42*Math.PI/180);
    let support=this.ground(add(p,V(0,-.65,0)),.4,c.bodyId);
    if(support&&(support.normal.y<minimumNormal||p.y-support.point.y>=.96))support=null;
    // The rounded sole can stand on a stair edge ahead of its centre. A
    // centre ray alone incorrectly called this real supporting contact air.
    for(const handle of this.state.entities[c.bodyId].colliders){const collider=this.physics.getCollider(handle);
      this.physics.contactPairsWith(collider,other=>{
        if((other.collisionGroups()&0xffff)===0||this.state.entities[this.state.colliderBodies[other.handle]]?.kind==='rope-segment')return;
        this.physics.contactPair(collider,other,(manifold,flipped)=>{
          const normal=mul(manifold.normal(),flipped?1:-1);if(normal.y<minimumNormal)return;
          for(let i=0;i<manifold.numSolverContacts();i++){
            const point=manifold.solverContactPoint(i);if(!point||manifold.solverContactDist(i)>.035||point.y>p.y-.5||p.y-point.y>1)continue;
            if(!support||normal.y>support.normal.y||point.y>support.point.y+.02)support={point:{...point},normal,bodyId:this.state.colliderBodies[other.handle]??null,material:(this.state.colliderMaterials[other.handle]??'soil')as MaterialId,collider:other};
          }
        });
      });
    }
    if(support&&this.state.tick-c.jumpTick<8){const owner=support.collider.parent(),velocity=owner?this.pointVelocity(owner,support.point):V();if(body.linvel().y-velocity.y>.1)return null;}
    return support;
  }
  updateMasses():void{
    const extras:Record<string,number>={};
    extras['equipment-crate']=Object.values(this.state.inventory).filter(i=>i.state==='stored').reduce((n,i)=>n+i.mass,0);
    for(const link of Object.values(this.state.links))if(!link.broken&&link.kind==='strap'&&link.itemId){extras[link.fromId]=(extras[link.fromId]??0)+1;extras[link.toId]=(extras[link.toId]??0)+1;}
    for(const link of Object.values(this.state.links))if(link.kind==='rope'&&link.spoolMass)extras[link.fromId]=(extras[link.fromId]??0)-link.spoolMass;
    for(const e of Object.values(this.state.entities))if(e.active&&!e.fixed&&e.kind!=='rope-segment'){
      const mass=e.baseMass+(extras[e.id]??0);const b=this.body(e.id);const current=b.mass();if(Math.abs(current-mass)<.001)continue;
      const colliderMass=e.colliders.reduce((sum,h)=>sum+this.physics.getCollider(h).mass(),0);
      for(const h of e.colliders){const c=this.physics.getCollider(h);const ratio=colliderMass>0?c.mass()/colliderMass:1/e.colliders.length;c.setMass(mass*ratio);}b.recomputeMassPropertiesFromColliders();
    }
  }
  addLink(kind:LinkRecord['kind'],fromId:string,fromSocket:string,toId:string,toSocket:string,itemId:string|null=null):LinkRecord{
    const a=this.socket(fromId,fromSocket),b=this.socket(toId,toSocket);if(!a||!b)throw new Error('UNKNOWN_SOCKET');const dist=distance(a.world,b.world);const id=`link-${this.state.nextLinkId++}`;
    const limit=kind==='strap'?9000:kind==='deck'?42000:kind==='ferry-lock'?50000:kind==='rope'?20000:15000;
    const link:LinkRecord={id,kind,fromId,fromSocket,toId,toSocket,itemId,jointHandles:[],length:dist,limit,tension:0,overload:0,broken:false,lastDistance:dist,effectiveMass:Math.min(this.body(fromId).mass()||1e9,this.body(toId).mass()||1e9)};
    if(kind==='rope'){this.createRope(link);}
    else if(kind!=='strap'){
      const ba=this.body(fromId),bb=this.body(toId);
      const data=kind==='ferry-lock'?RAPIER.JointData.fixed(a.local,conjugate(ba.rotation()),b.local,conjugate(bb.rotation())):RAPIER.JointData.spherical(a.local,b.local);
      const joint=this.physics.createImpulseJoint(data,ba,bb,true);joint.setContactsEnabled(fromSocket!=='drive');link.jointHandles.push(joint.handle);
    }
    this.state.links[id]=link;
    if(itemId&&this.state.inventory[itemId]){const item=this.state.inventory[itemId];if(item.bodyId&&this.state.entities[item.bodyId]?.active)this.removeBody(item.bodyId);item.state='attached';delete item.bodyId;}
    this.updateMasses();return link;
  }
  private createRope(link:LinkRecord):void{
    const a=this.socket(link.fromId,link.fromSocket)!,b=this.socket(link.toId,link.toSocket)!;
    const delta=sub(b.world,a.world),ropeLength=clamp(length(delta)+.05,1.5,18);
    link.length=ropeLength;link.trim=0;link.segments=[];link.limitForce=link.fromId==='truck'?14000:10000;
    const count=Math.ceil(ropeLength/.75),segmentLength=ropeLength/count,direction=norm(delta);
    const axis=cross(V(0,1,0),direction),angle=Math.acos(clamp(direction.y,-1,1));
    const q=length(axis)<.0001?(direction.y>=0?Q():quatAxis(V(1,0,0),Math.PI)):quatAxis(norm(axis),angle);
    let previous:string|null=null;
    for(let i=0;i<count;i++){
      const id=`rope:${link.id}:${i}`,pos=add(a.world,mul(direction,(i+.5)*segmentLength));
      this.addBody({id,kind:'rope-segment',position:pos,rotation:q,size:V(.08,segmentLength,.08),mass:2.9*segmentLength/18});
      for(const h of this.state.entities[id].colliders)this.physics.getCollider(h).setCollisionGroups((2<<16)|1);
      link.segments.push({id,length:segmentLength});
      if(previous){const j=this.physics.createImpulseJoint(RAPIER.JointData.spherical(V(0,segmentLength/2,0),V(0,-segmentLength/2,0)),this.body(previous),this.body(id),true);j.setContactsEnabled(false);link.jointHandles.push(j.handle);}
      previous=id;
    }
    const last=link.segments.at(-1)!;
    link.hookId=`hook:${link.id}`;this.addBody({id:link.hookId,kind:'hook',position:b.world});
    const endJoint=this.physics.createImpulseJoint(RAPIER.JointData.spherical(V(0,last.length/2,0),V()),this.body(last.id),this.body(link.hookId),true);endJoint.setContactsEnabled(false);link.jointHandles.push(endJoint.handle);
    // The last contact segment and the cargo meet at the hook. Connecting
    // those bodies directly also excludes their adjacent contact: otherwise
    // the cable end embedded in an authored eye fights the same attachment.
    const hookJoint=this.physics.createImpulseJoint(RAPIER.JointData.spherical(V(0,last.length/2,0),b.local),this.body(last.id),this.body(link.toId),true);hookJoint.setContactsEnabled(false);link.hookJoint=hookJoint.handle;link.detached=false;
    for(const h of this.state.entities[link.hookId].colliders)this.physics.getCollider(h).setCollisionGroups(0x00010000);
    // A swivelling drum collar lets the first cable segment point freely in
    // three dimensions. Its force-limited prismatic motor reels material in;
    // no endpoint or cargo transform is reassigned by the winch.
    link.collarId=`rope:${link.id}:collar`;
    const collar=this.addBody({id:link.collarId,kind:'rope-segment',position:a.world,rotation:q,size:V(.04,.04,.04),mass:.02});
    for(const h of collar.colliders)this.physics.getCollider(h).setCollisionGroups(0x00010000);
    const swivel=this.physics.createImpulseJoint(RAPIER.JointData.spherical(a.local,V()),this.body(link.fromId),this.body(link.collarId),true);swivel.setContactsEnabled(false);link.collarJoint=swivel.handle;
    this.createDrumJoint(link);link.spoolMass=.1+2.9*ropeLength/18;
  }
  private createDrumJoint(link:LinkRecord):void{
    if(link.drumJoint!==undefined){const old=this.physics.impulseJoints.get(link.drumJoint);if(old)this.physics.removeImpulseJoint(old,true);}
    const first=link.segments![0];
    const data=RAPIER.JointData.prismatic(V(),V(0,-first.length/2+(link.trim??0),0),V(0,1,0));data.limitsEnabled=true;data.limits=[-.05,Math.max(.05,18-link.length+.05)];
    const joint=this.physics.createImpulseJoint(data,this.body(link.collarId!),this.body(first.id),true)as RAPIER.PrismaticImpulseJoint;
    joint.setContactsEnabled(false);joint.configureMotorModel(RAPIER.MotorModel.ForceBased);joint.configureMotorPosition(0,120000,5000);joint.setMotorMaxForce(link.limitForce??10000);link.drumJoint=joint.handle;
  }
  private updateRopeMass(link:LinkRecord):void{
    const first=link.segments![0],remaining=Math.max(.04,first.length-(link.trim??0));
    const e=this.state.entities[first.id],collider=this.physics.getCollider(e.colliders[0]);
    collider.setShape(new RAPIER.Capsule(Math.max(.001,remaining/2-.04),.04));collider.setTranslationWrtParent(V(0,(link.trim??0)/2,0));
    collider.setMass(2.9*remaining/18);this.body(first.id).recomputeMassPropertiesFromColliders();
    link.spoolMass=.1+link.segments!.reduce((sum,s)=>sum+this.body(s.id).mass(),0);this.updateMasses();
  }
  detachLink(id:string,broken=false):void{
    const l=this.state.links[id];if(!l||l.broken)return;
    if(!broken&&this.map.id==='tutorial'&&this.state.tutorial.step===3&&l.kind==='strap'&&l.itemId&&(l.fromId==='cargo-2'||l.toId==='cargo-2'))this.state.tutorial.flags[`removed:${l.itemId}`]=1;
    if(l.kind==='rope'){
      if(broken){
        if(l.collarJoint!==undefined){const joint=this.physics.impulseJoints.get(l.collarJoint);if(joint)this.physics.removeImpulseJoint(joint,true);delete l.collarJoint;}
        l.broken=true;
        // The free drum end becomes a graspable physical hook. The far hook,
        // the remaining chain and all current velocities stay on the cargo.
        if(l.collarId){const e=this.state.entities[l.collarId];e.kind='hook';e.size={...BODY.hook.size};e.sockets=socketsFor('hook',e.size);for(const h of e.colliders){const collider=this.physics.getCollider(h);collider.setShape(new RAPIER.Cuboid(.09,.11,.06));collider.setCollisionGroups(0xffffffff);}}
      }else{
        if(l.hookJoint!==undefined){const joint=this.physics.impulseJoints.get(l.hookJoint);if(joint)this.physics.removeImpulseJoint(joint,true);delete l.hookJoint;}
        if(l.hookId)for(const h of this.state.entities[l.hookId].colliders)this.physics.getCollider(h).setCollisionGroups(0xffffffff);
        l.detached=true;
      }
      for(const c of Object.values(this.state.characters))if(c.controlling===l.id)c.controlling=null;
    }else{
      for(const h of l.jointHandles){const joint=this.physics.impulseJoints.get(h);if(joint)this.physics.removeImpulseJoint(joint,true);}l.jointHandles=[];l.broken=true;
      if(l.itemId){const item=this.state.inventory[l.itemId];const pos=this.socket(l.fromId,l.fromSocket)?.world??this.body(l.fromId).translation();if(item){item.state='world';item.bodyId=item.id;this.addBody({id:item.id,kind:item.kind,position:add(pos,V(0,.15,0))});}}
    }
    this.updateMasses();this.emit(broken?'connection-broke':'detached',l.toId,undefined,l.tension);
  }
  reattachRope(link:LinkRecord,toId:string,toSocket:string):void{
    const target=this.socket(toId,toSocket);if(!target||!link.hookId||link.broken||!link.detached)throw new Error('INVALID_ACTION');
    const hook=this.body(link.hookId);if(distance(hook.translation(),target.world)>.3)throw new Error('ALIGN');
    const last=link.segments!.at(-1)!;
    const joint=this.physics.createImpulseJoint(RAPIER.JointData.spherical(V(0,last.length/2,0),target.local),this.body(last.id),this.body(toId),true);joint.setContactsEnabled(false);
    for(const h of this.state.entities[link.hookId].colliders)this.physics.getCollider(h).setCollisionGroups(0x00010000);
    link.hookJoint=joint.handle;link.toId=toId;link.toSocket=toSocket;link.detached=false;link.overload=0;
    for(const c of Object.values(this.state.characters))if(c.holding?.itemId===link.hookId)c.holding=null;
  }
  repairRope(link:LinkRecord):void{
    if(!link.broken||!link.collarId)throw new Error('NO_REPAIR');
    const source=this.socket(link.fromId,link.fromSocket)!,collar=this.body(link.collarId);
    if(distance(source.world,collar.translation())>.3)throw new Error('ALIGN');
    const joint=this.physics.createImpulseJoint(RAPIER.JointData.spherical(source.local,V()),this.body(link.fromId),collar,true);joint.setContactsEnabled(false);link.collarJoint=joint.handle;
    link.broken=false;link.overload=0;link.tension=0;
    const e=this.state.entities[link.collarId];e.kind='rope-segment';e.sockets=[];for(const h of e.colliders)this.physics.getCollider(h).setCollisionGroups(0x00010000);
    for(const c of Object.values(this.state.characters))if(c.holding?.itemId===link.collarId)c.holding=null;
  }
  setInput(participantId:string,input:TyagaInput):void{this.inputs[participantId]=normalizeInput(input);}
  setControllers(controllers:ControllerState[]):void{
    for(const incoming of controllers){const c=this.state.characters[incoming.participantId];if(!c)continue;const previous=c.controller;
      if(previous.kind!==incoming.kind||previous.controllerGeneration!==incoming.controllerGeneration){this.inputs[incoming.participantId]={...NEUTRAL_INPUT};if(incoming.kind==='bot')c.task={kind:'follow',status:'following',failures:0,failedAt:0};this.emit('controller',c.bodyId,incoming.participantId);}
      c.controller={...incoming};
    }
    if(this.state.vote&&this.controllerFingerprint()!==this.state.vote.controllerFingerprint)this.cancelVote('CONTROLLERS_CHANGED');
  }
  controllerFingerprint():string{return Object.values(this.state.characters).filter(c=>c.controller.kind==='human'&&c.controller.connected).map(c=>`${c.participant.participantId}:${c.controller.controllerGeneration}`).sort().join('|');}
  cancelVote(reason:string):void{this.state.vote=null;this.state.phase=Object.values(this.state.entities).some(e=>e.required&&e.integrity===0)?'failed':'running';this.state.voteCooldown=15;this.emit('vote-cancelled',undefined,undefined,undefined,{ru:reason==='CONTROLLERS_CHANGED'?'Состав команды изменился. Подтвердите заново.':'Решение отменено.',en:reason==='CONTROLLERS_CHANGED'?'The connected crew changed. Confirm again.':'Vote cancelled.'});}
  action(participantId:string,action:unknown):ActionResult{return performAction(this,participantId,action);}
  step(inputs?:Record<string,unknown>,context?:{controllers:ControllerState[];elapsedSeconds:number;attempt:number;dt:number}):void{
    if(context){this.setControllers(context.controllers);this.state.elapsedSeconds=context.elapsedSeconds;this.state.rewinds=context.attempt;}
    if(inputs)for(const [id,input]of Object.entries(inputs))if(this.state.characters[id])this.inputs[id]=normalizeInput(input);
    if(this.state.phase==='finished')return;
    // Decision timers use the runtime's fixed steps even when failed physics
    // is paused. A declined rewind must not lock the crew out permanently.
    if(this.state.voteCooldown>0)this.state.voteCooldown=Math.max(0,this.state.voteCooldown-DT);
    if(this.state.phase==='failed')return;
    if(this.state.vote){this.state.vote.remaining-=DT;if(this.state.vote.remaining<=0)this.cancelVote('TIMEOUT');return;}
    if(!context)this.state.elapsedSeconds+=DT;
    for(const c of Object.values(this.state.characters))if(c.controller.kind==='bot'){
      if(this.state.tick%6!==0&&c.botMemory.input){this.inputs[c.participant.participantId]={...c.botMemory.input};continue;}
      const decision=chooseBotAction(this.view(c.participant.participantId),c.botMemory,this.state.worldTime);
      c.botMemory.input={...decision.input};
      if(decision.status&&c.task)c.task.status=decision.status;if(decision.message)this.emit('bot-report',c.task?.targetId,c.participant.participantId,undefined,decision.message);
      this.inputs[c.participant.participantId]=decision.input;
      if(decision.action){const result=this.action(c.participant.participantId,decision.action);if(!result.result.ok&&c.task){c.task.failures++;c.task.failedAt=this.state.worldTime;if(c.task.failures>=2){c.task.status=result.result.code;this.releaseCharacter(c.participant.participantId);}}}
    }
    this.physicsStep();
    for(const [id,operation]of Object.entries(this.state.operations)){
      const c=this.state.characters[id];if(!c){this.cancelOperation(id);continue;}
      if(distance(this.body(c.bodyId).translation(),operation.startPosition)>1.7||!c.grounded&&!c.controlling){this.cancelOperation(id);this.emit('operation-cancelled',operation.targetId,id);continue;}
      operation.remaining-=DT;
      if(operation.remaining<=0){this.cancelOperation(id);finishOperation(this,id,operation);}
    }
    this.state.worldTime+=DT;this.state.tick++;
    this.updateZones();advanceTutorial(this);
  }
  private physicsStep():void{
    for(const e of Object.values(this.state.entities))if(e.active&&!e.fixed){const b=this.body(e.id);b.resetForces(false);b.resetTorques(false);this.state.previousVelocities[e.id]={...b.linvel()};}
    this.physics.propagateModifiedBodyPositionsToColliders();
    this.updateTruck();this.updateCharacters();this.updateHands();this.updateStraps();this.updateRopes();this.updateMechanisms();this.updateWeather();
    this.physics.step(this.queue);this.physics.propagateModifiedBodyPositionsToColliders();
    this.updateRopeLoads();this.updateConnections();this.updateDamage();if(!this.warming)this.updateRescue();
  }
  private updateTruck():void{
    const b=this.body('truck'),p=b.translation(),q=b.rotation();const up=rotate(q,V(0,1,0));
    const input=this.state.truck.driver?this.inputs[this.state.truck.driver]??NEUTRAL_INPUT:NEUTRAL_INPUT;
    if(input.throttle&&!input.brake&&!this.state.truck.brakeHolder)this.state.truck.brake=false;
    const brake=this.state.truck.brake||input.brake||Boolean(this.state.truck.brakeHolder);
    const forward=rotate(q,V(1,0,0));const speed=dot(b.linvel(),forward);const supportedMass=this.cargoMass();
    const records=this.state.truck.wheels;const associated=new Set(['truck','equipment-crate',...Object.values(this.state.links).filter(l=>!l.broken&&l.kind==='strap'&&l.toId==='truck').map(l=>l.fromId)]);
    let i=0;
    for(const x of [1.8,-1.8])for(const z of [-1.05,1.05]){
      const local=V(x,.05,z);const origin=worldPoint(p,q,local);const direction=mul(up,-1);const ray=new RAPIER.Ray(origin,direction);
      const hit=this.physics.castRayAndGetNormal(ray,1.28,true,undefined,undefined,undefined,b,c=>(c.collisionGroups()&0xffff)!==0&&!associated.has(this.state.colliderBodies[c.handle])&&this.state.entities[this.state.colliderBodies[c.handle]]?.kind!=='rope-segment');
      const old=records[i];const steer=x>0?input.steer*PHYSICS.steering:0;let suspension=.78;let wheelPosition=add(origin,mul(direction,.78));let grounded=false;
      if(hit&&dot(hit.normal,up)>.05){
        grounded=true;suspension=Math.max(.08,hit.timeOfImpact-.5);wheelPosition=add(origin,mul(direction,suspension));
        const contact=add(origin,mul(direction,hit.timeOfImpact));const normal={...hit.normal};
        const support=hit.collider.parent();const supportVelocity=support?this.pointVelocity(support,contact):V();const velocity=sub(this.pointVelocity(b,contact),supportVelocity);
        const compression=clamp(.78-suspension,0,.35);const spring=clamp(compression*PHYSICS.spring-dot(velocity,normal)*PHYSICS.damping,0,18000);
        const mu=FRICTION[(this.state.colliderMaterials[hit.collider.handle]??'soil')as MaterialId];
        const tireForward=norm(sub(rotate(quatMul(q,yawQuat(steer)),V(1,0,0)),mul(normal,dot(rotate(quatMul(q,yawQuat(steer)),V(1,0,0)),normal))));
        const lateral=norm(cross(tireForward,normal));const fwdSpeed=dot(velocity,tireForward);const sideSpeed=dot(velocity,lateral);
        let engine=input.throttle*PHYSICS.driveForce/4;
        if(input.throttle>0)engine*=clamp((PHYSICS.forwardSpeed-speed)/.2,0,1);else if(input.throttle<0)engine*=clamp((PHYSICS.reverseSpeed+speed)/.2,0,1);
        const rolling=-clamp(fwdSpeed*600,-spring*.012,spring*.012);
        const braking=brake?-clamp(fwdSpeed*(b.mass()+supportedMass)/(4*.18),-PHYSICS.brakeForce/4,PHYSICS.brakeForce/4):0;
        const lateralForce=-sideSpeed*(b.mass()+supportedMass)/(4*.18);
        let tire=add(mul(tireForward,engine+rolling+braking),mul(lateral,lateralForce));const frictionLimit=mu*spring;
        if(brake&&Math.abs(fwdSpeed)<.75){
          let grip=this.state.truck.grips[i];
          if(!grip||grip.supportHandle!==(support?.handle??null)){grip={supportHandle:support?.handle??null,point:support?localPoint(support.translation(),support.rotation(),contact):{...contact}};this.state.truck.grips[i]=grip;}
          const anchor=support?worldPoint(support.translation(),support.rotation(),grip.point):grip.point;
          const displacement=sub(contact,anchor);const tangent=sub(displacement,mul(normal,dot(displacement,normal)));
          // Finite tyre carcass stiffness supplies static friction. It is
          // capped by mu*N and can slip, including on a moving ferry deck.
          tire=add(tire,mul(tangent,-8000));
          if(length(tangent)>1)grip.point=support?localPoint(support.translation(),support.rotation(),contact):{...contact};
        }else this.state.truck.grips[i]=null;
        if(length(tire)>frictionLimit)tire=mul(norm(tire),frictionLimit);
        const total=add(mul(normal,spring),tire);b.addForceAtPoint(total,contact,true);if(support?.isDynamic())support.addForceAtPoint(mul(total,-1),contact,true);
      }
      if(!grounded)this.state.truck.grips[i]=null;
      records[i]={position:wheelPosition,suspension,rotation:(old?.rotation??0)+speed*DT/.5,steer,grounded};i++;
    }
  }
  carriedBodyIds():Set<string>{
    const ids=new Set<string>(['truck']),queue=['truck'],truck=this.body('truck');
    for(const link of Object.values(this.state.links))if(!link.broken&&link.kind==='strap'&&link.tension>1&&link.toId==='truck'){ids.add(link.fromId);queue.push(link.fromId);}
    while(queue.length){const id=queue.shift()!,entity=this.state.entities[id];if(!entity?.active)continue;
      for(const h of entity.colliders)this.physics.contactPairsWith(this.physics.getCollider(h),other=>{
        const otherId=this.state.colliderBodies[other.handle],e=this.state.entities[otherId];
        if(!e?.active||e.fixed||ids.has(otherId)||['rope-segment','hook'].includes(e.kind))return;
        const p=localPoint(truck.translation(),truck.rotation(),this.body(otherId).translation());
        if(e.kind!=='crate'&&(p.y<.15||Math.abs(p.x)>4.4||Math.abs(p.z)>2.1))return;
        let touching=false;this.physics.contactPair(this.physics.getCollider(h),other,m=>{if(m.numSolverContacts()>0)touching=true;});
        if(touching){ids.add(otherId);queue.push(otherId);}
      });
    }
    for(const c of Object.values(this.state.characters))if(c.controlling==='truck')ids.add(c.bodyId);
    ids.delete('truck');return ids;
  }
  private cargoMass():number{return[...this.carriedBodyIds()].reduce((mass,id)=>mass+this.body(id).mass(),0);}

  hasSupportedLoad(id:string):boolean{
    const e=this.state.entities[id],body=this.maybeBody(id);if(!e?.active||!body)return false;
    if(Object.values(this.state.characters).some(c=>c.grounded&&c.groundBodyId===id))return true;
    let loaded=false;
    for(const h of e.colliders){const collider=this.physics.getCollider(h);this.physics.contactPairsWith(collider,other=>{
      const otherId=this.state.colliderBodies[other.handle],otherBody=other.parent();if(!otherBody?.isDynamic()||otherId===id||this.state.entities[otherId]?.kind==='rope-segment')return;
      if(otherBody.translation().y<=body.translation().y+.04)return;
      this.physics.contactPair(collider,other,manifold=>{if(manifold.numSolverContacts()>0&&Math.abs(manifold.normal().y)>.4)loaded=true;});
    });}
    return loaded;
  }

  private updateCharacters():void{
    for(const [id,c]of Object.entries(this.state.characters)){
      if(c.rescueAt!==null)continue;
      const b=this.body(c.bodyId);if(c.controlling==='truck'&&c.seatJoint!==null)continue;
      if(c.controlling){
        const link=this.state.links[c.controlling];const controlPoint=link?this.socket(link.fromId,link.fromSocket)?.world:c.controlling==='rear-brake'?this.socket('truck','rear-brake')?.world:c.controlling==='lift-platform'?null:this.closestSocket(c.controlling,add(b.translation(),V(0,.25,0)),'control')?.world;
        if(controlPoint&&distance(add(b.translation(),V(0,.25,0)),controlPoint)>1.7){this.releaseCharacter(id);this.emit('control-released',c.bodyId,id,undefined,{ru:'Вы отошли от управления',en:'You moved away from the control'});}
      }
      const input=this.inputs[id]??NEUTRAL_INPUT;const p=b.translation();const g=this.characterSupport(id);
      c.grounded=Boolean(g);c.groundBodyId=g?.bodyId??null;
      const support=g?.collider.parent();const supportVelocity=support&&support.isDynamic()?this.pointVelocity(support,p):V();
      const holding=c.holding?this.state.entities[c.holding.itemId]:null;
      const speed=holding?(this.body(holding.id).mass()>55?1.3:2):input.run?4.4:3.2;
      const moving=Math.hypot(input.moveX,input.moveZ)>.01;
      if(moving&&!c.controlling)c.heading=-Math.atan2(input.moveZ,input.moveX);
      const target=c.controlling?V():V(input.moveX*speed,0,input.moveZ*speed);
      const relative=sub(b.linvel(),supportVelocity);let desired=V(target.x-relative.x,0,target.z-relative.z);
      desired=mul(desired,b.mass()/DT);const max=b.mass()*PHYSICS.acceleration;
      if(length(desired)>max)desired=mul(norm(desired),max);
      if(!c.grounded)desired=mul(desired,.25);
      if(moving){const obstacle=this.physics.castRay(new RAPIER.Ray(add(p,V(0,-.25,0)),norm(V(input.moveX,0,input.moveZ))),.62,true,undefined,undefined,undefined,b);
        if(obstacle?.collider.parent()?.isDynamic()&&length(desired)>PHYSICS.pushForce)desired=mul(norm(desired),PHYSICS.pushForce);
        // A small ledge is climbed with real upward acceleration, never by
        // assigning a new transform to the character.
        const lowObstacle=this.physics.castRay(new RAPIER.Ray(add(p,V(0,-.86,0)),norm(V(input.moveX,0,input.moveZ))),.5,true,undefined,undefined,undefined,b);
        if(lowObstacle&&this.state.tick-c.jumpTick>8&&(!lowObstacle.collider.parent()?.isDynamic()||this.state.entities[this.state.colliderBodies[lowObstacle.collider.handle]]?.kind==='ramp')){
          const ahead=add(p,mul(norm(V(input.moveX,0,input.moveZ)),lowObstacle.timeOfImpact+.035));const step=this.ground(ahead,1.2,c.bodyId);
          if(step&&step.point.y>p.y-.875+.03&&step.point.y<=p.y-.875+.25){
            let footContact:Vec3|null=null;
            if(!c.grounded)for(const handle of this.state.entities[c.bodyId].colliders)this.physics.contactPair(this.physics.getCollider(handle),lowObstacle.collider,(manifold,flipped)=>{
              const normal=mul(manifold.normal(),flipped?1:-1);if(normal.y<.1)return;
              for(let i=0;i<manifold.numSolverContacts();i++){const point=manifold.solverContactPoint(i);if(point&&manifold.solverContactDist(i)<.035&&point.y<p.y-.5&&p.y-point.y<1)footContact={...point};}
            });
            // A loaded character can keep pushing against the real low stair
            // lip after its centre ray leaves the previous tread. No force is
            // supplied in free flight, or for a step higher than 25 cm.
            if(c.grounded||footContact){b.addForce(V(0,2200,0),true);const reaction=c.grounded?support:lowObstacle.collider.parent();if(reaction?.isDynamic())reaction.addForceAtPoint(V(0,-2200,0),footContact??g!.point,true);}
          }
        }
      }
      b.addForce(desired,true);
      if(c.grounded&&support?.isDynamic())support.addForceAtPoint(mul(desired,-1),g!.point,true);
      if(!c.grounded&&g&&g.normal.y<Math.cos(42*Math.PI/180)){/* gravity supplies the real slide */}
      if(c.grounded&&length(b.linvel())<1){c.safeTime+=DT;if(c.safeTime>=2&&this.safeGround(p))c.safePoint={...p};}else c.safeTime=0;
      c.lastPosition={...p};
    }
  }
  private updateHands():void{
    for(const [id,c]of Object.entries(this.state.characters)){
      if(!c.holding)continue;const item=this.maybeBody(c.holding.itemId),person=this.body(c.bodyId);const socket=this.socket(c.holding.itemId,c.holding.handleId);
      if(!item||!socket){c.holding=null;continue;}
      c.holding.offset.y=clamp(c.holding.offset.y+(this.inputs[id]?.tool??0)*.5*DT,-1.1,.8);
      const hand=add(person.translation(),c.holding.offset);const error=sub(hand,socket.world);
      if(length(error)>PHYSICS.maxHandStretch&&this.state.worldTime-c.holding.since>.4){this.emit('released',c.holding.itemId,id);c.holding=null;continue;}
      const relative=sub(this.pointVelocity(item,socket.world),person.linvel());let force=sub(mul(error,1800),mul(relative,110));
      force.y=clamp(force.y,-PHYSICS.handForce,PHYSICS.handForce);
      if(length(force)>PHYSICS.handForce)force=mul(norm(force),PHYSICS.handForce);
      item.addForceAtPoint(force,socket.world,true);person.addForce(mul(force,-1),true);
      if(item.mass()<=55&&c.holding.yawTarget!==undefined){
        // A wrist can aim a light tool, but its torque spends the remaining
        // 700 N hand budget at a 12 cm lever. Nothing locks a body orientation.
        const available=Math.min(20,Math.max(0,PHYSICS.handForce-length(force))*.12);
        const torque=clamp(angleDifference(c.holding.yawTarget,yaw(item.rotation()))*Math.min(80,item.mass()*2)-item.angvel().y*Math.min(20,item.mass()*.5),-available,available);
        item.addTorque(V(0,torque,0),true);
      }
    }
  }
  private updateStraps():void{
    for(const link of Object.values(this.state.links))if(link.kind==='strap'&&!link.broken){
      const a=this.socket(link.fromId,link.fromSocket),b=this.socket(link.toId,link.toSocket);if(!a||!b){this.detachLink(link.id,true);continue;}
      const ba=this.body(link.fromId),bb=this.body(link.toId),delta=sub(b.world,a.world),d=length(delta),axis=norm(delta);
      const extension=Math.max(0,d-link.length-.05);
      const speed=dot(sub(this.pointVelocity(bb,b.world),this.pointVelocity(ba,a.world)),axis);
      // A webbing strap is a unilateral compliant constraint: it carries
      // tension, never compression. Its measured force is the applied force.
      link.tension=extension>0?Math.max(0,extension*60000+speed*650):0;
      const force=mul(axis,Math.min(link.tension,45000));
      if(ba.isDynamic())ba.addForceAtPoint(force,a.world,true);
      if(bb.isDynamic())bb.addForceAtPoint(mul(force,-1),b.world,true);
      link.lastDistance=d;link.overload=link.tension>link.limit?link.overload+DT:0;
      if(link.overload>=.25)this.detachLink(link.id,true);
    }
  }
  private updateRopes():void{
    for(const link of Object.values(this.state.links)){
      if(link.kind!=='rope'||link.broken||!link.segments?.length||!link.collarId||link.drumJoint===undefined)continue;
      const first=link.segments[0],body=this.body(first.id),drum=this.socket(link.fromId,link.fromSocket)!,source=this.body(link.fromId);
      const firstEnd=this.bodyPoint(first.id,V(0,-first.length/2+(link.trim??0),0));
      const axis=rotate(this.body(link.collarId).rotation(),V(0,1,0));
      const extension=dot(sub(firstEnd,drum.world),axis);
      const velocity=dot(sub(this.pointVelocity(body,firstEnd),this.pointVelocity(source,drum.world)),axis);
      const operator=Object.values(this.state.characters).find(c=>c.controlling===link.id);
      const input=operator?this.inputs[operator.participant.participantId]??NEUTRAL_INPUT:NEUTRAL_INPUT;
      if(Math.abs(input.tool)>.001){
        // Changing a motor anchor does not wake sleeping bodies in Rapier.
        // A real operator input wakes the connected physical island first.
        source.wakeUp();this.maybeBody(link.toId)?.wakeUp();this.body(link.collarId).wakeUp();
        if(link.hookId)this.body(link.hookId).wakeUp();for(const segment of link.segments)this.body(segment.id).wakeUp();
      }
      const pullLimit=link.limitForce??10000;
      const demand=Math.max(0,extension*120000+velocity*5000);
      // At full payout a mechanical end stop bears cable load; it does not
      // increase the motor's pulling force or shorten the cable.
      const maximum=link.length>=18&&input.tool<=0?40000:pullLimit;
      link.tension=link.tension*.65+Math.min(demand,maximum)*.35;
      const motor=this.physics.impulseJoints.get(link.drumJoint)as RAPIER.PrismaticImpulseJoint;
      motor.setMotorMaxForce(maximum);motor.setLimits(-.05,Math.max(.05,18-link.length+.05));
      const rate=Math.max(.2,1-.8*clamp(link.tension/pullLimit,0,1));
      if(input.tool>0&&link.length>1.5&&link.tension<pullLimit*.98){
        const amount=Math.min(input.tool*rate*DT,link.length-1.5);link.length-=amount;link.trim=(link.trim??0)+amount;
        motor.setAnchor2(V(0,-first.length/2+link.trim,0));
        if(link.trim>=first.length-.05&&link.segments.length>2){
          const jointHandle=link.jointHandles.shift();if(jointHandle!==undefined){const joint=this.physics.impulseJoints.get(jointHandle);if(joint)this.physics.removeImpulseJoint(joint,true);}
          const oldMotor=this.physics.impulseJoints.get(link.drumJoint);if(oldMotor)this.physics.removeImpulseJoint(oldMotor,true);delete link.drumJoint;
          this.removeBody(first.id);link.segments.shift();link.trim-=first.length;this.createDrumJoint(link);
        }
        this.updateRopeMass(link);
      }else if((input.tool<0||input.tool===0&&demand>pullLimit&&extension>.08)&&link.length<18){
        const amount=Math.min(input.tool<0?-input.tool*DT:Math.min(extension-.05,5*DT),18-link.length);link.length+=amount;link.trim=(link.trim??0)-amount;
        motor.setAnchor2(V(0,-first.length/2+link.trim,0));
        if(link.trim<-.7){
          const length=.7,tail=this.bodyPoint(first.id,V(0,-first.length/2,0)),direction=norm(sub(tail,drum.world));
          const turn=cross(V(0,1,0),direction),q=Math.hypot(turn.x,turn.y,turn.z)<.0001?Q():quatAxis(norm(turn),Math.acos(clamp(direction.y,-1,1)));
          const id=`rope:${link.id}:add-${this.state.tick}`;
          this.addBody({id,kind:'rope-segment',position:mix(drum.world,tail,.5),rotation:q,size:V(.08,length,.08),mass:2.9*length/18});
          for(const h of this.state.entities[id].colliders)this.physics.getCollider(h).setCollisionGroups((2<<16)|1);
          this.body(id).setLinvel(this.pointVelocity(source,drum.world),true);
          const joint=this.physics.createImpulseJoint(RAPIER.JointData.spherical(V(0,length/2,0),V(0,-first.length/2,0)),this.body(id),body,true);joint.setContactsEnabled(false);
          const oldCollider=this.physics.getCollider(this.state.entities[first.id].colliders[0]);oldCollider.setShape(new RAPIER.Capsule(Math.max(.001,first.length/2-.04),.04));oldCollider.setTranslationWrtParent(V());oldCollider.setMass(2.9*first.length/18);body.recomputeMassPropertiesFromColliders();
          link.jointHandles.unshift(joint.handle);link.segments.unshift({id,length});link.trim+=length;this.createDrumJoint(link);
        }
        this.updateRopeMass(link);
      }
    }
  }
  private contactReaction(id:string):Vec3{
    let reaction=V();const e=this.state.entities[id];if(!e?.active)return reaction;
    for(const h of e.colliders){const collider=this.physics.getCollider(h);
      this.physics.contactPairsWith(collider,other=>this.physics.contactPair(collider,other,(manifold,flipped)=>{
        let impulse=0;for(let i=0;i<manifold.numContacts();i++)impulse+=manifold.contactImpulse(i);
        reaction=add(reaction,mul(manifold.normal(),(flipped?1:-1)*impulse/DT));
      }));
    }
    return reaction;
  }
  private updateRopeLoads():void{
    for(const link of Object.values(this.state.links))if(link.kind==='rope'&&!link.broken){
      const target=this.maybeBody(link.toId);
      if(target?.isDynamic()&&!link.detached){
        const before=this.state.previousVelocities[link.toId]??target.linvel();
        const inertial=mul(sub(target.linvel(),before),target.mass()/DT);
        const external=add(add(target.userForce(),V(0,-target.mass()*PHYSICS.gravity,0)),this.contactReaction(link.toId));
        const connected=Object.values(this.state.links).filter(other=>!other.broken&&!other.detached&&other.kind==='rope'&&other.toId===link.toId).length;
        const load=length(sub(inertial,external))/Math.max(1,connected);
        link.tension=link.tension*.4+Math.max(link.tension,load)*.6;
      }
      link.overload=link.tension>PHYSICS.ropeBreakForce?link.overload+DT:0;
      if(link.overload>=PHYSICS.overloadTime)this.detachLink(link.id,true);
    }
  }
  private updateConnections():void{
    for(const link of Object.values(this.state.links))if(!link.broken&&link.kind!=='rope'&&link.kind!=='strap'){
      const a=this.socket(link.fromId,link.fromSocket),b=this.socket(link.toId,link.toSocket);if(!a||!b){this.detachLink(link.id,true);continue;}
      const d=distance(a.world,b.world);const stretch=Math.max(0,d-link.length);
      const ba=this.body(link.fromId),bb=this.body(link.toId);const relative=this.pointVelocity(bb,b.world);const normal=norm(sub(b.world,a.world));
      const relativeSpeed=dot(sub(relative,this.pointVelocity(ba,a.world)),normal);
      const acceleration=dot(sub(bb.linvel(),this.state.previousVelocities[link.toId]??bb.linvel()),normal)/DT;
      const load=stretch*180000+Math.max(0,relativeSpeed)*link.effectiveMass/DT;
      // Constraint reaction estimate uses acceleration + gravity along the
      // connection. A resting short strap remains below its calibrated limit.
      const supportLoad=Math.max(0,Math.abs(acceleration+PHYSICS.gravity*normal.y)*link.effectiveMass);
      link.tension=link.tension*.7+Math.max(load,supportLoad)*.3;
      link.lastDistance=d;if(link.tension>link.limit)link.overload+=DT;else link.overload=0;
      if(link.overload>=.25)this.detachLink(link.id,true);
    }
    for(const e of Object.values(this.state.entities))if(e.active&&(e.anchored||e.anchorLimit!==undefined)){
      const links=Object.values(this.state.links).filter(l=>!l.broken&&!l.detached&&(l.fromId===e.id||l.toId===e.id));let resultant=V();
      for(const link of links){const from=this.socket(link.fromId,link.fromSocket),to=this.socket(link.toId,link.toSocket);if(from&&to)resultant=add(resultant,mul(norm(sub(to.world,from.world)),link.tension*(link.fromId===e.id?1:-1)));}
      if(length(resultant)>(e.anchorLimit??22000)){
        for(const link of links)this.detachLink(link.id,true);
        if(e.kind==='ring')this.removeBody(e.id);else{e.anchored=false;e.fixed=false;this.body(e.id).setBodyType(RAPIER.RigidBodyType.Dynamic,true);}
        this.emit('anchor-pulled',e.id);
      }
    }
  }
  private updateMechanisms():void{
    for(const operation of Object.values(this.state.operations))if(operation.action.type==='install-drive'){
      const {itemId,targetId}=operation.action,drive=this.maybeBody(itemId),parent=this.maybeBody(targetId),own=this.socket(itemId,'drive'),target=this.socket(targetId,'drive');
      if(!drive||!parent||!own||!target)continue;
      const error=sub(target.world,own.world),relative=sub(this.pointVelocity(drive,own.world),this.pointVelocity(parent,target.world));
      let force=add(sub(mul(error,10000),mul(relative,1000)),V(0,drive.mass()*PHYSICS.gravity,0));if(length(force)>700)force=mul(norm(force),700);
      drive.addForceAtPoint(force,own.world,true);if(parent.isDynamic())parent.addForceAtPoint(mul(force,-1),target.world,true);
      const q=quatMul(parent.rotation(),conjugate(drive.rotation())),sign=q.w<0?-1:1;
      const correction=mul(V(q.x,q.y,q.z),sign*700);const damping=mul(sub(drive.angvel(),parent.angvel()),80);
      let torque=sub(sub(correction,damping),cross(sub(own.world,drive.worldCom()),force));if(length(torque)>350)torque=mul(norm(torque),350);
      drive.addTorque(torque,true);if(parent.isDynamic())parent.addTorque(mul(torque,-1),true);
    }
    const ferry=this.state.machinery.ferry;
    if(ferry){
      for(const id of ['pontoon-left','pontoon-right'])this.buoyancy(id);
      if(ferry.launched&&ferry.driveId&&ferry.operator){const input=this.inputs[ferry.operator]??NEUTRAL_INPUT;const drive=this.body(ferry.driveId);const q=quatMul(drive.rotation(),yawQuat(input.steer*Math.PI/6));const point=this.bodyPoint(ferry.driveId,V(-.25528,-.433033,0));const water=this.map.waterVolumes.find(w=>point.x>=w.min.x&&point.x<=w.max.x&&point.z>=w.min.z&&point.z<=w.max.z),level=water?water.baseLevel+water.amplitude*Math.sin(this.state.worldTime*2*Math.PI/water.period):null;const immersed=level===null?0:clamp((level-point.y+.307536)/.615071,0,1);drive.addForceAtPoint(mul(rotate(q,V(1,0,0)),1800*input.throttle*immersed),point,true);ferry.propellerAngle+=input.throttle*DT*25;}
    }
    const lift=this.state.machinery.lift;
    if(lift){
      const b=this.body('lift-platform'),p=b.translation();
      const input=lift.operator?this.inputs[lift.operator]??NEUTRAL_INPUT:NEUTRAL_INPUT;
      const barriers=Object.values(lift.barriers).every(Boolean);
      if(lift.driveId&&!lift.cableBroken&&barriers&&lift.operator)lift.targetHeight=clamp(lift.targetHeight+input.tool*.12*DT,10.1,16.1);
      const supportedMass=this.liftLoad();const demanded=(lift.targetHeight-p.y)*250000-b.linvel().y*32000+supportedMass*PHYSICS.gravity;
      const desired=clamp(demanded,0,60000);
      if(!lift.cableBroken){for(const x of [-3,3])b.addForceAtPoint(V(0,desired/2,0),this.bodyPoint('lift-platform',V(x,0,0)),true);}
      else if(lift.catchHeight!==null){const joint=this.physics.impulseJoints.get(lift.guideJoint)as RAPIER.PrismaticImpulseJoint;const h=lift.catchHeight-10.1;joint.setLimits(Math.max(0,h-.15),6);}
      lift.overloadSeconds=supportedMass*PHYSICS.gravity>70000?lift.overloadSeconds+DT:0;
      if(!lift.cableBroken&&lift.overloadSeconds>=.25){lift.cableBroken=true;lift.catchHeight=p.y;this.emit('lift-catch','lift-platform');}
    }
    for(const[id,jack]of Object.entries(this.state.machinery.jacks)){
      const b=this.maybeBody(id),target=this.maybeBody(jack.targetId);if(!b||!target)continue;
      const ground=this.ground(add(b.translation(),V(0,-.15,0)),.6,id);if(!ground||ground.normal.y<Math.cos(12*Math.PI/180)){delete this.state.machinery.jacks[id];continue;}
      const operator=Object.values(this.state.characters).find(c=>c.controlling===id);const input=operator?this.inputs[operator.participant.participantId]??NEUTRAL_INPUT:NEUTRAL_INPUT;
      jack.height=clamp(jack.height+input.tool*.1*DT,0,.8);
      const point=worldPoint(target.translation(),target.rotation(),jack.targetSocket);const top=b.translation().y+.13+jack.height;
      const force=clamp((top-point.y)*150000-this.pointVelocity(target,point).y*5000,0,15000);target.addForceAtPoint(V(0,force,0),point,true);b.addForce(V(0,-force,0),true);
    }
  }
  ferryLoad():number{
    if(!this.state.machinery.ferry)return 0;
    const ids=new Set<string>(['ferry-deck']),queue=['ferry-deck'];
    for(const link of Object.values(this.state.links))if(!link.broken&&link.kind==='ferry-lock'&&link.fromId==='ferry-deck'){ids.add(link.toId);queue.push(link.toId);}
    while(queue.length){const id=queue.shift()!,e=this.state.entities[id];if(!e?.active)continue;
      for(const h of e.colliders)this.physics.contactPairsWith(this.physics.getCollider(h),other=>{
        const next=this.state.colliderBodies[other.handle],entity=this.state.entities[next];if(!entity?.active||entity.fixed||ids.has(next)||['rope-segment','hook','ramp'].includes(entity.kind))return;
        let touching=false;this.physics.contactPair(this.physics.getCollider(h),other,m=>{if(m.numSolverContacts()>0)touching=true;});if(touching){ids.add(next);queue.push(next);}
      });
    }
    if(ids.has('truck'))for(const c of Object.values(this.state.characters))if(c.controlling==='truck')ids.add(c.bodyId);
    return[...ids].reduce((mass,id)=>mass+(this.maybeBody(id)?.mass()??0),0);
  }
  liftLoad():number{
    const platform=this.maybeBody('lift-platform');if(!platform)return 0;
    const ids=new Set<string>(['lift-platform','lift-barrier-near','lift-barrier-far']),queue=[...ids];
    while(queue.length){const id=queue.shift()!,e=this.state.entities[id];if(!e?.active)continue;
      for(const h of e.colliders)this.physics.contactPairsWith(this.physics.getCollider(h),other=>{
        const next=this.state.colliderBodies[other.handle],entity=this.state.entities[next];if(!entity?.active||entity.fixed||ids.has(next)||['rope-segment','hook'].includes(entity.kind))return;
        if(this.body(next).translation().y<platform.translation().y-.2)return;
        let touching=false;this.physics.contactPair(this.physics.getCollider(h),other,m=>{if(m.numSolverContacts()>0)touching=true;});if(touching){ids.add(next);queue.push(next);}
      });
    }
    if(ids.has('truck'))for(const c of Object.values(this.state.characters))if(c.controlling==='truck')ids.add(c.bodyId);
    return[...ids].reduce((mass,id)=>mass+(this.maybeBody(id)?.mass()??0),0);
  }
  waterLevel():number|null{const water=this.map.waterVolumes[0];return water?water.baseLevel+water.amplitude*Math.sin(this.state.worldTime*2*Math.PI/water.period):null;}
  private buoyancy(id:string):void{
    const e=this.state.entities[id],b=this.body(id),p=b.translation();const water=this.map.waterVolumes.find(w=>p.x>=w.min.x-3&&p.x<=w.max.x+3&&p.z>=w.min.z-.8&&p.z<=w.max.z+.8);if(!water)return;
    const level=water.baseLevel+water.amplitude*Math.sin(this.state.worldTime*2*Math.PI/water.period);
    // 24 submerged columns sample the true tilted pontoon; each column's force
    // acts at its submerged centroid, so displaced mass creates roll and pitch.
    const cellsX=8,cellsZ=3,dx=e.size.x/cellsX,dz=e.size.z/cellsZ;
    for(let ix=0;ix<cellsX;ix++)for(let iz=0;iz<cellsZ;iz++){
      const local=V(-e.size.x/2+(ix+.5)*dx,0,-e.size.z/2+(iz+.5)*dz);const center=this.bodyPoint(id,local);const localUp=rotate(b.rotation(),V(0,1,0));const halfVertical=Math.abs(localUp.y)*e.size.y/2;
      const fraction=clamp((level-(center.y-halfVertical))/(2*halfVertical||e.size.y),0,1);if(!fraction)continue;
      const depth=e.size.y*fraction;const forcePoint=this.bodyPoint(id,add(local,V(0,-e.size.y/2+depth/2,0)));const velocity=this.pointVelocity(b,forcePoint);
      b.addForceAtPoint(V(0,1000*PHYSICS.gravity*dx*dz*depth,0),forcePoint,true);
      const drag=V(-velocity.x*(200+120*Math.abs(velocity.x))*dz*depth,-velocity.y*350*dx*dz,-velocity.z*(200+120*Math.abs(velocity.z))*dx*depth);
      b.addForceAtPoint(add(drag,mul(water.flow,dx*depth/cellsZ)),forcePoint,true);
    }
  }
  wind():{force:Vec3;gust:boolean;warning:boolean}{
    const w=this.map.windProfile;if(!w)return{force:V(),gust:false,warning:false};const t=this.state.worldTime;
    const phase=(t-w.firstCalm+w.period)%w.period;const started=t>=w.firstCalm;const gust=started&&phase<w.duration;const until=started?w.period-phase:w.firstCalm-t;const warning=!gust&&until<=w.warning;
    return{force:mul(w.direction,gust?w.gust:w.base),gust,warning};
  }
  private updateWeather():void{
    const wind=this.wind().force;const level=this.waterLevel();
    for(const e of Object.values(this.state.entities))if(e.active&&!e.fixed&&e.kind!=='rope-segment'){
      const b=this.body(e.id),p=b.translation();if(length(wind)){
        const shield=this.map.id==='ridge'&&p.x>104&&p.x<150&&p.z>75?.25:1;const q=b.rotation();const x=rotate(q,V(e.size.x,0,0)),y=rotate(q,V(0,e.size.y,0));const area=Math.abs(x.x*y.y-x.y*y.x)+.1;
        b.addForceAtPoint(mul(wind,area*shield),add(p,V(0,e.size.y*.1,0)),true);
      }
      if(level!==null&&e.kind!=='pontoon'&&e.kind!=='ferry-deck'){
        const water=this.map.waterVolumes.find(w=>p.x>w.min.x&&p.x<w.max.x&&p.z>w.min.z&&p.z<w.max.z);
        if(water){const submerged=clamp(level-(p.y-e.size.y/2),0,e.size.y);if(submerged>0){b.addForce(mul(water.flow,e.size.x*submerged),true);b.addForce(V(-b.linvel().x*120*submerged,0,-b.linvel().z*120*submerged),true);}}
      }
    }
  }
  private updateDamage():void{
    this.queue.drainContactForceEvents(event=>{
      const colliderA=this.physics.getCollider(event.collider1()),colliderB=this.physics.getCollider(event.collider2());
      const idA=this.state.colliderBodies[event.collider1()],idB=this.state.colliderBodies[event.collider2()];
      if(!colliderA||!colliderB||idA===idB)return;
      const key=[idA,idB].sort().join(':');
      if(this.state.worldTime-(this.state.contactCooldown[key]??-1)<.25)return;
      const va=this.state.previousVelocities[idA]??V(),vb=this.state.previousVelocities[idB]??V();
      let impulse=0,impactSpeed=0;
      this.physics.contactPair(colliderA,colliderB,manifold=>{
        const normal=manifold.normal();impactSpeed=Math.max(impactSpeed,Math.abs(dot(sub(va,vb),normal)));
        for(let i=0;i<manifold.numContacts();i++)impulse+=Math.max(0,manifold.contactImpulse(i));
      });
      // Supporting a settled mass is not an impact. Normal impulses are read
      // from Rapier's contact manifold, not a sum of opposing contact forces.
      if(impactSpeed<.5)return;
      let damaged=false;
      for(const id of [idA,idB]){const e=this.state.entities[id];if(!e?.active||e.integrity===undefined)continue;const profile=BODY[e.kind];if(profile.safeImpulse===undefined)continue;const dv=impulse/Math.max(this.body(id).mass(),1);const damage=Math.min(25,(profile.damageFactor??1)*Math.max(0,dv-profile.safeImpulse)**2);if(damage>.001){this.damage(id,damage);damaged=true;}}
      if(damaged)this.state.contactCooldown[key]=this.state.worldTime;
    });
    const level=this.waterLevel();
    for(const e of Object.values(this.state.entities))if(e.active&&e.required){
      const b=this.body(e.id),p=b.translation();if(p.y<this.map.abyssY){if(!this.warming){e.integrity=0;this.state.phase='failed';this.state.truck.brake=true;this.emit('cargo-lost',e.id);}continue;}
      const water=level===null?null:this.map.waterVolumes.find(w=>p.x>w.min.x&&p.x<w.max.x&&p.z>w.min.z&&p.z<w.max.z);
      const vulnerable=['truck','generator','generator-large','optics','mast'].includes(e.kind);
      const center=e.kind==='truck'?this.bodyPoint(e.id,V(2.4,.1,0)):p;
      if(water&&level!==null&&vulnerable&&center.y<level){e.submergedSeconds+=DT;if(e.submergedSeconds>3)this.damage(e.id,5*DT);}else e.submergedSeconds=0;
    }
  }
  damage(id:string,amount:number):void{
    const e=this.state.entities[id];if(!e||e.integrity===undefined||e.integrity<=0||this.warming||this.state.mode!=='expedition')return;
    const before=e.integrity;e.integrity=Math.max(0,before-amount);if(amount>.2)this.emit('damage',id,undefined,before-e.integrity);
    if(e.integrity<=0&&e.required){this.state.phase='failed';this.state.truck.brake=true;this.emit('cargo-lost',id);}
  }
  safeGround(point:Vec3):boolean{
    const truck=this.body('truck').translation();if(distance(point,truck)>22)return false;
    const samples=Math.ceil(Math.hypot(point.x-truck.x,point.z-truck.z));
    for(let n=0;n<=samples;n++){const p=mix(point,truck,n/(samples||1));const hit=this.ground(add(p,V(0,2,0)),5);if(!hit||hit.point.y<this.map.abyssY+3)return false;}
    return true;
  }
  private updateRescue():void{
    const level=this.waterLevel();for(const [id,c]of Object.entries(this.state.characters)){
      const b=this.body(c.bodyId),p=b.translation();c.rescueCooldown=Math.max(0,c.rescueCooldown-DT);
      if(c.rescueAt!==null){if(this.state.worldTime>=c.rescueAt)this.completeRescue(id);continue;}
      const water=level!==null&&this.map.waterVolumes.some(w=>p.x>w.min.x&&p.x<w.max.x&&p.z>w.min.z&&p.z<w.max.z);
      if(water&&level!==null&&p.y<level)c.submergedFor+=DT;else c.submergedFor=0;
      if(p.y<this.map.abyssY||c.submergedFor>3)this.beginRescue(id);
    }
  }
  beginRescue(id:string):void{const c=this.state.characters[id];if(!c||c.rescueAt!==null)return;this.releaseCharacter(id);c.rescueAt=this.state.worldTime+3;this.emit('rescue-start',c.bodyId,id);}
  private completeRescue(id:string):void{
    const c=this.state.characters[id],b=this.body(c.bodyId);let target=c.safePoint;let placed=false;
    for(let i=0;i<24;i++){const r=i*.125,angle=i*2.399963;const p=add(target,V(Math.cos(angle)*r,.05,Math.sin(angle)*r));const collision=this.physics.intersectionWithShape(p,Q(),new RAPIER.Capsule(.575,.3),undefined,undefined,undefined,b);if(!collision){target=p;placed=true;break;}}
    if(!placed)target=add(this.map.start,V(-5,.95,5));b.setTranslation(target,true);b.setLinvel(V(),true);b.setAngvel(V(),true);c.rescueAt=null;c.rescueCooldown=10;c.submergedFor=0;this.emit('rescued',c.bodyId,id);
  }
  cancelOperation(id:string):void{const operation=this.state.operations[id];if(operation?.guideJoint!==undefined){const joint=this.physics.impulseJoints.get(operation.guideJoint);if(joint)this.physics.removeImpulseJoint(joint,true);}delete this.state.operations[id];}
  releaseCharacter(id:string):void{
    const c=this.state.characters[id];if(!c)return;
    c.holding=null;this.cancelOperation(id);this.inputs[id]={...NEUTRAL_INPUT};
    if(c.seatJoint!==null){const j=this.physics.impulseJoints.get(c.seatJoint);if(j)this.physics.removeImpulseJoint(j,true);c.seatJoint=null;const b=this.body(c.bodyId);b.lockRotations(true,true);for(const h of this.state.entities[c.bodyId].colliders)this.physics.getCollider(h).setCollisionGroups(0xffffffff);}
    if(this.state.truck.driver===id){this.state.truck.driver=null;this.state.truck.brake=true;}
    if(this.state.truck.brakeHolder===id)this.state.truck.brakeHolder=null;
    if(this.state.machinery.ferry?.operator===id)this.state.machinery.ferry.operator=null;
    if(this.state.machinery.lift?.operator===id)this.state.machinery.lift.operator=null;
    c.controlling=null;
  }
  updateZones():void{for(const zone of [...this.map.checkpoints,this.map.finish]){const valid=zoneConditions(this,zone).ok;this.state.zoneReadySeconds[zone.id]=valid?(this.state.zoneReadySeconds[zone.id]??0)+DT:0;}}
  zoneContains(zone:MapZone,id:string):boolean{
    const e=this.state.entities[id];if(!e?.active)return false;const b=this.body(id);const p=b.translation(),q=b.rotation();
    for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){const corner=worldPoint(p,q,V(x*e.size.x/2,y*e.size.y/2,z*e.size.z/2));if(Math.abs(corner.x-zone.position.x)>zone.size.x/2||Math.abs(corner.z-zone.position.z)>zone.size.z/2||corner.y<zone.position.y-.2||corner.y>zone.position.y+zone.size.y)return false;}
    return true;
  }
  afterRewind(meta:{attempt:number;elapsedSeconds:number}):void{this.state.rewinds=meta.attempt;this.state.elapsedSeconds=meta.elapsedSeconds;this.state.phase='running';this.state.vote=null;for(const id of Object.keys(this.state.operations))this.cancelOperation(id);this.inputs={};for(const c of Object.values(this.state.characters)){c.holding=null;c.task=c.controller.kind==='bot'?{kind:'follow',status:'following',failures:0,failedAt:0}:null;}this.state.truck.brake=true;this.emit('rewound');if(this.map.id==='tutorial'&&this.state.tutorial.step===7&&this.state.tutorial.checkpointDone){this.state.tutorial.completed=true;this.state.tutorial.step=8;}}
  entityView(e:EntityRecord):EntityView{
    const b=this.body(e.id);const character=Object.values(this.state.characters).find(c=>c.bodyId===e.id);const speed=length(b.linvel());
    let animation:EntityView['animation']='idle';
    if(character){if(character.controlling==='truck')animation='driver';else if(this.state.operations[character.participant.participantId]?.action.type==='repair')animation='repair';else if(character.controlling)animation=Math.abs(this.inputs[character.participant.participantId]?.tool??0)>.01||Math.abs(this.inputs[character.participant.participantId]?.throttle??0)>.01?'crank':'hold';else if(character.holding)animation='carry';else if(!character.grounded)animation=b.linvel().y>0?'jump':'fall';else if(speed>.3)animation=speed>3.3?'run':'walk';}
    const mechanism:NonNullable<EntityView['mechanism']>={};
    const rope=Object.values(this.state.links).find(l=>l.kind==='rope'&&l.fromId===e.id&&l.spoolMass);
    if(rope)mechanism.drumAngle=-rope.length/.16;
    const jack=this.state.machinery.jacks[e.id];if(jack)mechanism.piston=jack.height;
    const ferry=this.state.machinery.ferry;if(ferry?.driveId===e.id){mechanism.propellerAngle=ferry.propellerAngle;mechanism.steer=(ferry.operator?this.inputs[ferry.operator]?.steer??0:0)*Math.PI/6;}
    if(e.id==='lift-transmission')mechanism.drumAngle=(this.body('lift-platform').translation().y-10.1)/.16;
    return{id:e.id,kind:e.kind,model:e.customModel??BODY[e.kind].model,name:BODY[e.kind].name,position:{...b.translation()},rotation:character&&!character.controlling?yawQuat(character.heading):{...b.rotation()},size:{...e.size},velocity:{...b.linvel()},angularVelocity:{...b.angvel()},mass:b.mass(),...(Object.keys(mechanism).length?{mechanism}:{}),...(e.integrity!==undefined?{integrity:e.integrity}:{}),required:e.required,active:e.active,sockets:e.sockets.map(s=>this.socket(e.id,s.id)!),...(character?{participantId:character.participant.participantId,seatIndex:character.participant.seatIndex,appearance:character.participant.appearance??{head:(character.participant.seatIndex%2)as 0|1,backpack:(Math.floor(character.participant.seatIndex/2)%2)as 0|1},animation}:{}),state:e.kind==='barrier'?(this.state.machinery.lift?.barriers[e.id]?'closed':'open'):e.folded?'folded':e.anchored?'anchored':e.integrity===0?'destroyed':'normal'};
  }
  view(participantId:string):TyagaView{
    if(!this.state.characters[participantId])throw new Error('NOT_A_PARTICIPANT');
    const checkpoint=this.map.checkpoints.find(z=>this.zoneContains(z,'truck'))??this.map.checkpoints.find(z=>z.id!==this.state.checkpointId)??this.map.checkpoints.at(-1)!;
    const checkpointCondition=zoneConditions(this,checkpoint);const finishCondition=zoneConditions(this,this.map.finish);const wind=this.wind();
    const entities=Object.values(this.state.entities).filter(e=>e.active&&e.kind!=='rope-segment').map(e=>this.entityView(e));
    const truck=this.body('truck');
    const carried=this.carriedBodyIds();const load=this.cargoMass()-(carried.has('equipment-crate')?50:0)+(truck.mass()-1000);
    const machinery:TyagaView['machinery']={};
    const ferry=this.state.machinery.ferry;if(ferry){const deck=this.body('ferry-deck'),up=rotate(deck.rotation(),V(0,1,0));machinery.ferry={payload:Math.max(0,this.ferryLoad()-720),capacity:3500,draft:(this.waterLevel()??0)-(this.body('pontoon-left').translation().y+this.body('pontoon-right').translation().y)/2+.325,heel:Math.atan2(up.z,up.y),speed:length(deck.linvel()),launched:ferry.launched,driveId:ferry.driveId};}
    const lift=this.state.machinery.lift;if(lift)machinery.lift={payload:Math.max(0,this.liftLoad()-520),capacity:3800,height:this.body('lift-platform').translation().y-10.1,speed:this.body('lift-platform').linvel().y,cableBroken:lift.cableBroken,driveId:lift.driveId};
    return{gameId:'tyaga',rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,mapId:this.map.id,mode:this.state.mode,tick:this.state.tick,phase:this.state.phase,elapsedSeconds:this.state.elapsedSeconds,rewinds:this.state.rewinds,participantId,entities,
      participants:Object.values(this.state.characters).map(c=>({...c.participant,controller:c.controller.kind,connected:c.controller.connected,entityId:c.bodyId,controlling:c.controlling,holding:c.holding?.itemId??null,...(c.holding?{gripHeight:c.holding.offset.y}:{}),...(c.task?{task:{kind:c.task.kind,targetId:c.task.targetId,point:c.task.point,status:c.task.status,requestedBy:c.task.requestedBy}}:{}),...(c.rescueAt!==null?{rescueIn:Math.max(0,c.rescueAt-this.state.worldTime)}:{})})),
      connections:Object.values(this.state.links).map(l=>({id:l.id,kind:l.kind,fromId:l.fromId,fromSocket:l.fromSocket,toId:l.toId,toSocket:l.toSocket,...(l.itemId?{itemId:l.itemId}:{}),...(l.hookId?{hookId:l.hookId}:{}),...(l.detached?{detached:true}:{}),points:l.kind==='rope'&&l.segments?[l.broken&&l.collarId?{...this.body(l.collarId).translation()}:this.socket(l.fromId,l.fromSocket)?.world??V(),...l.segments.filter(s=>this.state.entities[s.id]?.active).map(s=>({...this.body(s.id).translation()})),l.hookId?{...this.body(l.hookId).translation()}:this.socket(l.toId,l.toSocket)?.world??V()]:[this.socket(l.fromId,l.fromSocket)?.world??V(),this.socket(l.toId,l.toSocket)?.world??V()],length:l.length,tension:l.tension,limit:l.limit,broken:l.broken})),
      inventory:Object.values(this.state.inventory).map(i=>({...i})),operations:Object.values(this.state.operations).map(o=>({participantId:o.participantId,type:o.action.type,targetId:o.targetId,progress:clamp(1-o.remaining/o.duration,0,1),duration:o.duration})),interactions:interactionsFor(this,participantId),events:this.state.events.map(e=>({...e})),
      truck:{integrity:this.state.entities.truck.integrity??0,speed:dot(truck.linvel(),rotate(truck.rotation(),V(1,0,0))),load,capacity:2100,brake:this.state.truck.brake,brakeHolder:this.state.truck.brakeHolder,driver:this.state.truck.driver,wheels:this.state.truck.wheels.map(w=>({...w}))},machinery,weather:{waterLevel:this.waterLevel(),wind:wind.force,gust:wind.gust,warning:wind.warning},
      checkpoint:{id:this.state.checkpointId,ready:checkpointCondition.ok&&(this.state.zoneReadySeconds[checkpoint.id]??0)>=3,reason:checkpointCondition.message,nextId:checkpoint.id,leftBehind:Object.values(this.state.entities).filter(e=>e.active&&!e.fixed&&!e.required&&e.kind!=='character'&&e.kind!=='rope-segment'&&!this.zoneContains(checkpoint,e.id)).length},finishReady:finishCondition.ok&&(this.state.zoneReadySeconds[this.map.finish.id]??0)>=3,finishReason:finishCondition.message,
      vote:this.state.vote?{kind:this.state.vote.kind,initiator:this.state.vote.initiator,checkpointId:this.state.vote.checkpointId,voters:[...this.state.vote.voters],yes:[...this.state.vote.yes],remainingSeconds:this.state.vote.remaining}:null,outcome:this.state.outcome,tutorial:this.map.id==='tutorial'?tutorialView(this):null,map:this.map};
  }
}
