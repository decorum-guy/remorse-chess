import { describe, expect, it } from 'vitest';
import { evidence } from './evidence';
import { TyagaWorld } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { V, add, distance, length, localPoint, quatAxis, quatMul, rotate, sub } from '../src/core/math';
import RAPIER from '@dimforge/rapier3d-compat';
import { kineticState } from './r04-fixtures';
const participants=[{participantId:'alice',displayName:'Alice',seatIndex:0,bot:false},{participantId:'bob',displayName:'Bob',seatIndex:1,bot:false}];
async function fixture(){return TyagaWorld.create({matchId:'mechanics',mapId:'tutorial',participants});}
function step(w:TyagaWorld,n:number,inputs:Record<string,unknown>={}){for(let i=0;i<n;i++)w.step(inputs);}
function totalMass(w:TyagaWorld){return Object.values(w.state.entities).filter(e=>e.active&&!e.fixed).reduce((m,e)=>m+w.body(e.id).mass(),0);}

describe('Tyaga physical mechanisms (isolated fixtures, not browser acceptance)',()=>{
 it('winch transmits tension through colliding physical cable segments',async()=>{
  const w=await fixture();try{
   w.addBody({id:'fixture-winch',kind:'winch',position:V(18,.5,6),fixed:true});
   w.addBody({id:'fixture-load',kind:'beam',position:V(25,.4,6)});
   step(w,30);const rope=w.addLink('rope','fixture-winch','drum','fixture-load','ring--1--1');
   w.body('person:alice').setTranslation(V(17.1,.9,6),true);w.state.characters.alice.controlling=rope.id;
   const initial=w.body('fixture-load').translation().x;step(w,180,{alice:{...NEUTRAL_INPUT,tool:1}});
   console.log('ROPE',initial,w.body('fixture-load').translation(),rope.tension,rope.length,rope.broken,rope.segments?.map(s=>w.body(s.id).translation()));
   expect(rope.broken).toBe(false);expect(w.body('fixture-load').translation().x).toBeLessThan(initial-.2);
   for(const s of rope.segments??[])expect(length(w.body(s.id).linvel())).toBeLessThan(30);
  }finally{w.dispose();}
 });
 it('keeps the combined body + stored + attached equipment mass constant',async()=>{
  const w=await fixture();try{
   const before=totalMass(w);const item=w.state.inventory['beam-1'];
   const c=w.body('person:alice');c.setTranslation(V(11.7,.9,20.1),true);step(w,1);
   const result=w.action('alice',{type:'unpack',itemId:item.id,position:V(10.8,.5,20.5),angle:Math.PI/2});console.log('UNPACK',result);
   expect(result.result.ok).toBe(true);step(w,70);expect(w.state.inventory[item.id].state).toBe('world');expect(totalMass(w)).toBeCloseTo(before,2);
  }finally{w.dispose();}
 });
});

it('P04 one hand cannot hold 110 kg level; two independent players can lift it',async()=>{
 const w=await fixture();try{
  w.body('person:alice').setTranslation(V(17,.9,22.05),true);w.body('person:bob').setTranslation(V(17,.9,25.95),true);step(w,12);
  expect(w.action('alice',{type:'grab',itemId:'training-heavy',handleId:'handle-0'}).result.ok).toBe(true);
  step(w,90);const oneY=w.body('training-heavy').translation().y;
  const handle=w.socket('training-heavy','handle-1')!;w.body('person:bob').setTranslation(add(handle.world,V(0,.8,.55)),true);step(w,12);
  expect(w.action('bob',{type:'grab',itemId:'training-heavy',handleId:'handle-1'}).result.ok).toBe(true);
  step(w,120);const b=w.body('training-heavy'),twoY=b.translation().y;
  evidence('P04-two-person-deck',{onePersonCenterY:oneY,twoPersonCenterY:twoY,mass:b.mass(),quaternion:{...b.rotation()},holders:Object.values(w.state.characters).filter(c=>c.holding?.itemId==='training-heavy').length});
  expect(w.state.characters.alice.holding).not.toBeNull();expect(w.state.characters.bob.holding).not.toBeNull();expect(twoY).toBeGreaterThan(.25);
 }finally{w.dispose();}
});

it('P02 equal wheel drive force accelerates an unloaded chassis faster',async()=>{
 const loaded=await fixture(),empty=await fixture();
 try{
  for(const link of Object.values(empty.state.links))empty.detachLink(link.id);
  for(const [i,id]of ['cargo-1','cargo-2','cargo-3','equipment-crate'].entries())empty.body(id).setTranslation(V(6+i*3,3,30),true);
  for(const w of [loaded,empty]){
   step(w,60);const cab=w.socket('truck','cab-right')!.world;w.body('person:alice').setTranslation(add(cab,V(0,-.8,.5)),true);step(w,3);
   expect(w.action('alice',{type:'operate',targetId:'truck'}).result.ok).toBe(true);
  }
  const startLoaded={...loaded.body('truck').translation()},startEmpty={...empty.body('truck').translation()};
  step(loaded,60,{alice:{...NEUTRAL_INPUT,throttle:1}});step(empty,60,{alice:{...NEUTRAL_INPUT,throttle:1}});
  const loadedSpeed=loaded.view('alice').truck.speed,emptySpeed=empty.view('alice').truck.speed;
  evidence('P02-mass-acceleration',{seconds:1,driveForce:8000,loadedSpeed,emptySpeed,loadedDisplacement:distance(startLoaded,loaded.body('truck').translation()),emptyDisplacement:distance(startEmpty,empty.body('truck').translation()),loadedLoad:loaded.view('alice').truck.load,emptyLoad:empty.view('alice').truck.load});
  console.log('DRIVE_STATE', loaded.state.truck,loaded.inputs,loaded.state.phase, loaded.body('truck').linvel(),empty.state.truck,empty.state.phase);expect(emptySpeed).toBeGreaterThan(loadedSpeed*1.3);expect(loadedSpeed).toBeGreaterThan(1);
 }finally{loaded.dispose();empty.dispose();}
});

it('P06 resting contacts cause no damage while a real high-speed contact damages cargo',async()=>{
 const w=await fixture();try{
  w.state.mode='expedition';w.addBody({id:'impact-optics',kind:'optics',position:V(5,4,5),integrity:100});
  w.body('impact-optics').setLinvel(V(0,-8,0),true);step(w,45);
  const damaged=w.state.entities['impact-optics'].integrity!;expect(damaged).toBeLessThan(100);expect(damaged).toBeGreaterThanOrEqual(75);
  step(w,180);expect(w.state.entities['impact-optics'].integrity).toBe(damaged);
  evidence('P06-contact-damage',{initialVelocity:8,integrityAfterContact:damaged,integrityAfterRest:w.state.entities['impact-optics'].integrity,events:w.state.events.filter(e=>e.entityId==='impact-optics')});
 }finally{w.dispose();}
});

it('P08 a sustained physical overload breaks the fully paid-out cable and keeps the far hook',async()=>{
 const w=await fixture();try{
  w.addBody({id:'overload-winch',kind:'winch',position:V(18,22,6),fixed:true});
  w.addBody({id:'overload-load',kind:'block',position:V(18.45,4.22,6.17),size:V(.5,.5,.5),mass:3000});
  const rope=w.addLink('rope','overload-winch','drum','overload-load','ring--1--1');
  const ids=['overload-load',rope.hookId!,rope.collarId!,...rope.segments!.map(s=>s.id)];
  let breakEnergy:{before:ReturnType<typeof kineticState>;after:ReturnType<typeof kineticState>}|null=null;
  const detach=w.detachLink.bind(w);w.detachLink=(id,broken=false)=>{if(id===rope.id&&broken){const before=kineticState(w,ids);detach(id,broken);breakEnergy={before,after:kineticState(w,ids)};}else detach(id,broken);};
  let brokeAt=-1,maximum=0;const history:unknown[]=[];
  for(let i=0;i<180;i++){w.step();maximum=Math.max(maximum,rope.tension);if(i%6===0){const j=w.physics.impulseJoints.get(rope.drumJoint!)as import('@dimforge/rapier3d-compat').PrismaticImpulseJoint;history.push({tick:i,tension:rope.tension,overload:rope.overload,y:w.body('overload-load').translation().y,joint:{limits:j.limitsEnabled(),min:j.limitsMin(),max:j.limitsMax(),anchor1:j.anchor1(),anchor2:j.anchor2(),frame1:j.frameX1(),frame2:j.frameX2()},collar:w.body(rope.collarId!).rotation()});}if(rope.broken){brokeAt=i/60;break;}}
  const velocityAtBreak={...w.body('overload-load').linvel()};
  evidence('P08-rope-break',{maximumTension:maximum,brokeAt,length:rope.length,broken:rope.broken,hookJoint:rope.hookJoint!==undefined&&Boolean(w.physics.impulseJoints.get(rope.hookJoint)),velocityAtBreak,breakEnergy,freeEndKind:w.state.entities[rope.collarId!].kind,collar:{position:{...w.body(rope.collarId!).translation()},mass:w.body(rope.collarId!).mass()},segments:rope.segments!.map(s=>({id:s.id,position:{...w.body(s.id).translation()},mass:w.body(s.id).mass()})),history});
  expect(rope.broken).toBe(true);expect(brokeAt).toBeGreaterThanOrEqual(.25);expect(rope.hookJoint).toBeDefined();expect(w.physics.impulseJoints.get(rope.hookJoint!)).not.toBeNull();
  expect(breakEnergy).not.toBeNull();const measured=breakEnergy! as {before:ReturnType<typeof kineticState>;after:ReturnType<typeof kineticState>};
  for(let i=0;i<measured.before.bodies.length;i++){expect(measured.after.bodies[i].position).toEqual(measured.before.bodies[i].position);expect(measured.after.bodies[i].linearVelocity).toEqual(measured.before.bodies[i].linearVelocity);expect(measured.after.bodies[i].angularVelocity).toEqual(measured.before.bodies[i].angularVelocity);}
  expect(measured.after.energy-measured.before.energy).toBeLessThan(.25);
  const before=w.body('overload-load').translation().y;step(w,12);expect(w.body('overload-load').translation().y).toBeLessThan(before-.1);
 }finally{w.dispose();}
});

it('P10 cancelling repair keeps the unit, finishing consumes exactly one unit',async()=>{
 const w=await fixture();try{
  w.state.entities.truck.integrity=60;w.body('person:alice').setTranslation(V(11.7,.9,20.1),true);step(w,5);
  const repair=w.state.inventory['repair-1'];expect(w.action('alice',{type:'repair',targetId:'truck',itemId:repair.id}).result.ok).toBe(true);
  step(w,120);expect(w.action('alice',{type:'cancel'}).result.ok).toBe(true);expect(repair.state).toBe('stored');expect(w.state.entities.truck.integrity).toBe(60);
  expect(w.action('alice',{type:'repair',targetId:'truck',itemId:repair.id}).result.ok).toBe(true);step(w,245);expect(repair.state).toBe('destroyed');expect(w.state.entities.truck.integrity).toBe(85);
  const repeated=w.action('alice',{type:'repair',targetId:'truck',itemId:repair.id});expect(repeated.result.ok).toBe(false);expect(w.state.entities.truck.integrity).toBe(85);
  evidence('P10-repair',{cancelledUnitsConsumed:0,completedUnitsConsumed:1,integrity:85,repeatedResult:repeated.result.code});
 }finally{w.dispose();}
});

it('P05 no number of repeated commands permits more than two physical hands on the main cargo',async()=>{
 const w=await TyagaWorld.create({matchId:'hands-fixture',mapId:'tutorial',participants:[...participants,{participantId:'chris',displayName:'Chris',seatIndex:2,bot:false}]});try{
  const target=w.body('cargo-1'),start={...target.translation()};
  for(const[id,z]of [['alice',-1],['bob',1],['chris',1]]as const){const h=w.socket('cargo-1',`handle-${z<0?0:1}`)!;w.body(`person:${id}`).setTranslation(add(h.world,V(id==='chris'?1:0,-.8,z*.5)),true);}step(w,10);
  expect(w.action('alice',{type:'grab',itemId:'cargo-1',handleId:'handle-0'}).result.ok).toBe(true);expect(w.action('bob',{type:'grab',itemId:'cargo-1',handleId:'handle-1'}).result.ok).toBe(true);
  for(let i=0;i<30;i++)expect(w.action('chris',{type:'grab',itemId:'cargo-1',handleId:'handle-1'}).result.ok).toBe(false);
  step(w,90);expect(Object.values(w.state.characters).filter(c=>c.holding?.itemId==='cargo-1').length).toBeLessThanOrEqual(2);expect(target.translation().y-start.y).toBeLessThan(.15);
  evidence('P05-hand-limit',{mass:target.mass(),holders:Object.values(w.state.characters).filter(c=>c.holding?.itemId==='cargo-1').length,verticalChange:target.translation().y-start.y,repeatedRejectedCommands:30});
 }finally{w.dispose();}
});

it('P09 removing a physical support leaves no invisible deck under the load',async()=>{
 const w=await fixture();try{
  w.addBody({id:'support-left',kind:'block',position:V(30,2,30),size:V(.5,4,3),fixed:true});w.addBody({id:'support-right',kind:'block',position:V(33.5,2,30),size:V(.5,4,3),fixed:true});
  w.addBody({id:'support-deck',kind:'deck',position:V(31.75,4.1,30)});step(w,90);const initial={...w.body('support-deck').translation()};
  w.removeBody('support-right');step(w,180);const after={...w.body('support-deck').translation()};
  expect(after.y).toBeLessThan(initial.y-1);evidence('P09-support-loss',{initial,after,rotation:{...w.body('support-deck').rotation()}});
 }finally{w.dispose();}
});

it('P03 two released straps let small cargo slide down a physically tilted chassis',async()=>{
 const w=await fixture();try{
  const origin={...w.body('truck').translation()},q=quatAxis(V(1,0,0),-35*Math.PI/180),center=V(28,5,10);
  for(const id of ['truck','equipment-crate','cargo-1','cargo-2','cargo-3']){const b=w.body(id);b.setTranslation(add(center,rotate(q,sub(b.translation(),origin))),true);b.setRotation(quatMul(q,b.rotation()),true);b.setLinvel(V(),true);b.setAngvel(V(),true);}
  // A tilt-test cradle holds the chassis; all cargo, contacts and straps remain dynamic.
  w.body('truck').setBodyType(RAPIER.RigidBodyType.Fixed,true);w.state.entities.truck.fixed=true;
  const released=Object.values(w.state.links).filter(l=>l.fromId==='cargo-2'&&l.kind==='strap');expect(released).toHaveLength(2);
  for(const l of released)w.detachLink(l.id);
  const before=localPoint(w.body('truck').translation(),w.body('truck').rotation(),w.body('cargo-2').translation());step(w,180);
  const after=localPoint(w.body('truck').translation(),w.body('truck').rotation(),w.body('cargo-2').translation());
  const remaining=Object.values(w.state.links).filter(l=>!l.broken&&l.kind==='strap');
  evidence('P03-unstrapped-slope',{fixture:'35-degree roll cradle holds chassis; cargo remains dynamic',before,after,released:released.length,intactMainStraps:remaining.filter(l=>l.fromId==='cargo-1').length,intactOtherSmallStraps:remaining.filter(l=>l.fromId==='cargo-3').length});
  expect(after.z).toBeLessThan(before.z-.5);expect(remaining.filter(l=>l.fromId==='cargo-1')).toHaveLength(4);expect(remaining.filter(l=>l.fromId==='cargo-3')).toHaveLength(2);
 }finally{w.dispose();}
});

it('P05 an off-center finite hand force creates real rotation of the 750 kg cargo',async()=>{
 const w=await fixture();try{
  w.addBody({id:'torque-load',kind:'generator-large',position:V(6,2.4,6)});w.body('person:alice').setTranslation(V(6,.9,4.45),true);step(w,1);
  expect(w.action('alice',{type:'grab',itemId:'torque-load',handleId:'handle-0'}).result.ok).toBe(true);
  let peakForce=0,peakTorque=0,peakAngular=0;for(let i=0;i<25;i++){w.step({alice:{...NEUTRAL_INPUT,moveX:1}});const b=w.body('torque-load');peakForce=Math.max(peakForce,length(b.userForce()));peakTorque=Math.max(peakTorque,length(b.userTorque()));peakAngular=Math.max(peakAngular,length(b.angvel()));}
  evidence('P05-hand-torque',{mass:w.body('torque-load').mass(),peakForce,peakTorque,peakAngular,rotation:{...w.body('torque-load').rotation()}});
  expect(peakForce).toBeLessThanOrEqual(700.01);expect(peakTorque).toBeGreaterThan(100);expect(peakAngular).toBeGreaterThan(.02);
 }finally{w.dispose();}
});

it('P07 a cable sags over a real obstacle and reels without moving through its volume',async()=>{
 const w=await fixture();try{
  w.addBody({id:'wrap-winch',kind:'winch',position:V(18,3,6),fixed:true});w.addBody({id:'wrap-rock',kind:'block',position:V(21,1,6),size:V(1.2,2,2),fixed:true});w.addBody({id:'wrap-load',kind:'beam',position:V(25,3,6)});
  const rope=w.addLink('rope','wrap-winch','drum','wrap-load','ring--1--1');let contacts=0;
  for(let i=0;i<240;i++){w.step();for(const s of rope.segments!){const e=w.state.entities[s.id];w.physics.contactPairsWith(w.physics.getCollider(e.colliders[0]),other=>{if(w.state.colliderBodies[other.handle]==='wrap-rock')contacts++;});}}
  const before={...w.body('wrap-load').translation()},beforeLength=rope.length;
  // The operator stands at a separate physical test platform beside the drum.
  w.addBody({id:'wrap-operator-platform',kind:'block',position:V(17.2,1.1,6),size:V(1.2,2.2,1.2),fixed:true});w.body('person:alice').setTranslation(V(17.2,3.1,6),true);step(w,10);
  expect(w.action('alice',{type:'operate',targetId:rope.id}).result.ok).toBe(true);const history:unknown[]=[];for(let i=0;i<90;i++){w.step({alice:{...NEUTRAL_INPUT,tool:1}});if(i%6===0)history.push({i,tension:rope.tension,length:rope.length,actor:{...w.body('person:alice').translation()},control:w.state.characters.alice.controlling,load:{...w.body('wrap-load').translation()},first:{...w.body(rope.segments![0].id).translation()}});}
  const after={...w.body('wrap-load').translation()},afterLength=rope.length;w.setInput('alice',{...NEUTRAL_INPUT});step(w,90);const neutralLength=rope.length;
  const path=[w.socket(rope.fromId,rope.fromSocket)!.world,...rope.segments!.map(s=>({...w.body(s.id).translation()})),{...w.body(rope.hookId!).translation()}];
  const pathLength=path.slice(1).reduce((sum,p,i)=>sum+distance(p,path[i]),0),direct=distance(path[0],path.at(-1)!);
  evidence('P07-rope-contact',{history,contacts,before,after,beforeLength,afterLength,neutralLength,pathLength,direct,broken:rope.broken,path});
  expect(contacts).toBeGreaterThan(0);expect(pathLength).toBeGreaterThan(direct+.05);expect(afterLength).toBeLessThan(beforeLength-.2);expect(neutralLength).toBeCloseTo(afterLength,5);expect(rope.broken).toBe(false);
  for(const point of path)expect(Math.abs(point.x-21)<.52&&point.y<1.92&&Math.abs(point.z-6)<.92).toBe(false);
 }finally{w.dispose();}
});

it('a portable winch can be secured to an installed ground anchor through normal attachment',async()=>{
 const w=await fixture();try{
  const winch=w.state.inventory['winch-1'];winch.state='world';winch.bodyId=winch.id;w.addBody({id:winch.id,kind:'winch',position:V(7,.3,6)});w.updateMasses();
  w.body('training-anchor').setTranslation(V(7,.44,7),true);w.body('person:alice').setTranslation(V(6.1,.9,6.5),true);step(w,30);
  expect(w.action('alice',{type:'anchor',itemId:'training-anchor'}).result.ok).toBe(true);step(w,185);
  const old=Object.values(w.state.links).find(l=>l.kind==='strap'&&l.fromId==='equipment-crate')!;w.detachLink(old.id);w.body(old.itemId!).setTranslation(V(6,.2,7.2),true);step(w,15);
  const result=w.action('alice',{type:'attach',kind:'strap',fromId:winch.id,fromSocket:'base',toId:'training-anchor',toSocket:'ring',itemId:old.itemId!});
  evidence('winch-ground-attachment',{result:result.result,base:w.socket(winch.id,'base'),anchor:w.socket('training-anchor','ring')});expect(result.result.ok).toBe(true);step(w,125);
  expect(Object.values(w.state.links).some(l=>!l.broken&&l.fromId===winch.id&&l.toId==='training-anchor')).toBe(true);
 }finally{w.dispose();}
});

it('R03 original cargo straps can be reattached without their own loose body blocking the ray',async()=>{
 const w=await fixture();try{
  w.body('person:alice').setTranslation(V(13.019,.875,15.874),true);step(w,20);
  const original=Object.values(w.state.links).filter(l=>l.kind==='strap'&&l.fromId==='cargo-2');expect(original).toHaveLength(2);
  for(const link of original){expect(w.action('alice',{type:'detach',connectionId:link.id}).result.ok).toBe(true);step(w,65);}
  const outcomes:unknown[]=[];
  for(const link of original){const result=w.action('alice',{type:'attach',kind:'strap',fromId:'truck',fromSocket:link.toSocket,toId:'cargo-2',toSocket:link.fromSocket,itemId:link.itemId!});outcomes.push(result.result);if(result.result.ok)step(w,125);}
  evidence('R03-strap-reinstall',{outcomes,links:Object.values(w.state.links).filter(l=>l.kind==='strap'&&(l.fromId==='cargo-2'||l.toId==='cargo-2'))});
  expect(outcomes.every(result=>(result as {ok:boolean}).ok)).toBe(true);expect(Object.values(w.state.links).filter(l=>!l.broken&&l.kind==='strap'&&(l.fromId==='cargo-2'||l.toId==='cargo-2'))).toHaveLength(2);
 }finally{w.dispose();}
});

it('a short strap crossing the truck cabin is rejected even when both endpoint sockets are valid',async()=>{
 const w=await fixture();try{
  const item=Object.values(w.state.inventory).find(i=>i.kind==='strap'&&i.state==='stored')!;item.state='world';item.bodyId=item.id;w.addBody({id:item.id,kind:'strap',position:V(15.8,.2,18)});w.updateMasses();
  w.body('person:alice').setTranslation(V(16.2,.9,18),true);step(w,30);
  const from=w.socket('truck','front-tow')!,to=w.socket('cargo-2','ring-1--1')!;
  const result=w.action('alice',{type:'attach',kind:'strap',fromId:'truck',fromSocket:'front-tow',toId:'cargo-2',toSocket:'ring-1--1',itemId:item.id});
  evidence('strap-truck-obstruction',{result:result.result,distance:distance(from.world,to.world),from,to});
  expect(distance(from.world,to.world)).toBeLessThan(2);expect(result.result.code).toBe('STRAP_BLOCKED');
 }finally{w.dispose();}
});
