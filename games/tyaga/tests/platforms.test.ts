import { expect, it } from 'vitest';
import { TyagaWorld } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { V, add, sub, Q, rotate, yaw, angleDifference } from '../src/core/math';
import { evidence } from './evidence';
const crew=Array.from({length:6},(_,i)=>({participantId:`person-${i}`,displayName:`Person ${i}`,seatIndex:i,bot:false}));
function step(w:TyagaWorld,n:number,inputs:Record<string,unknown>={}){for(let i=0;i<n;i++)w.step(inputs);}
function place(w:TyagaWorld,id:string,p:{x:number;y:number;z:number}){const b=w.body(id);b.setTranslation(p,true);b.setRotation(Q(),true);b.setLinvel(V(),true);b.setAngvel(V(),true);}
function moveLoadedTruck(w:TyagaWorld,p:{x:number;y:number;z:number}){
 const delta=sub(p,w.body('truck').translation());for(const id of ['truck','equipment-crate','cargo-1','cargo-2','cargo-3']){const b=w.body(id);b.setTranslation(add(b.translation(),delta),true);b.setLinvel(V(),true);b.setAngvel(V(),true);}w.state.truck.grips=[];
}
it('P11/P12 real second-map truck and six capsules float and produce lateral heel',async()=>{
 const w=await TyagaWorld.create({matchId:'ferry-physical-fixture',mapId:'quarry',mode:'practice',participants:crew});try{
  const ferry=w.state.machinery.ferry!;
  for(const h of ferry.supportHandles){const b=w.physics.getRigidBody(h);if(b)w.physics.removeRigidBody(b);}ferry.supportHandles=[];ferry.launched=true;
  place(w,'ferry-deck',V(58,-2.4,60));place(w,'pontoon-left',V(58,-2.825,58.3));place(w,'pontoon-right',V(58,-2.825,61.7));
  for(const x of [-1,1])for(const z of [-1,1])w.addLink('ferry-lock','ferry-deck',`lock-${x}-${z}`,z===-1?'pontoon-left':'pontoon-right',x===-1?'lock-rear':'lock-front');
  place(w,'ferry-drive',V(53.25,-3,62));w.addLink('ferry-lock','ferry-deck','drive','ferry-drive','drive');ferry.driveId='ferry-drive';
  moveLoadedTruck(w,V(58,-1.25,60));
  for(const[i,p]of crew.entries())place(w,`person:${p.participantId}`,V(58+[-2.8,0,2.8][Math.floor(i/2)],-1.40,60+(i%2?1.7:-1.7)));
  step(w,900);
  const level=w.waterLevel()!,left=w.body('pontoon-left').translation(),right=w.body('pontoon-right').translation(),deck=w.body('ferry-deck');
  const draft=level-(left.y+right.y)/2+.325,roll=Math.atan2(rotate(deck.rotation(),V(0,1,0)).z,rotate(deck.rotation(),V(0,1,0)).y);
  const assembly=['ferry-deck','pontoon-left','pontoon-right','ferry-drive','truck','equipment-crate','cargo-1','cargo-2','cargo-3',...crew.map(p=>`person:${p.participantId}`)].reduce((m,id)=>m+w.body(id).mass(),0);
  evidence('P11-ferry-draft',{steps:900,assemblyMass:assembly,payload:assembly-720,waterLevel:level,draft,theoreticalDraft:assembly/9600,rollRadians:roll,deckPosition:{...deck.translation()},platformVelocity:{...deck.linvel()},crew:crew.map(p=>({id:p.participantId,position:{...w.body(`person:${p.participantId}`).translation()},rescued:w.state.characters[p.participantId].rescueAt})),links:Object.values(w.state.links).filter(l=>l.kind==='ferry-lock').map(l=>({id:l.id,broken:l.broken,tension:l.tension}))});
  expect(assembly).toBeCloseTo(3779,1);expect(draft).toBeGreaterThan(.32);expect(draft).toBeLessThan(.49);expect(Math.abs(roll)).toBeLessThan(.12);expect(w.state.phase).toBe('running');
  const propulsionStart={...deck.translation()},headingBefore=yaw(deck.rotation()),trim=Math.atan2(2,5.00528)/(Math.PI/6);
  expect(w.action('person-1',{type:'operate',targetId:'ferry-deck'}).result.ok).toBe(true);
  step(w,240,{'person-1':{...NEUTRAL_INPUT,throttle:.5,steer:trim}});w.action('person-1',{type:'release'});
  const propulsionEnd={...deck.translation()},headingAfter=yaw(deck.rotation()),propellerCenter=w.bodyPoint('ferry-drive',V(-.25528,-.433033,0));
  evidence('P11-ferry-propulsion',{seconds:4,throttle:.5,trim,steerRadians:trim*Math.PI/6,propulsionStart,propulsionEnd,headingBefore,headingAfter,yawChange:angleDifference(headingAfter,headingBefore),propellerCenter,waterLevel:w.waterLevel(),rotatingPropellerTop:w.bodyPoint('ferry-drive',V(-.25528,-.125497,0)).y});
  expect(propellerCenter.z).toBeLessThan(72);expect(propulsionEnd.x-propulsionStart.x).toBeGreaterThan(.25);expect(Math.abs(angleDifference(headingAfter,headingBefore))).toBeLessThan(.2);expect(w.bodyPoint('ferry-drive',V(-.25528,-.125497,0)).y).toBeLessThan(w.waterLevel()!);
  const initialUp=rotate(deck.rotation(),V(0,1,0)),initialRoll=Math.atan2(initialUp.z,initialUp.y);
  // This deliberately arranged fixture shifts real bodies, not a COM scalar.
  for(const id of ['truck','equipment-crate','cargo-1','cargo-2','cargo-3']){const b=w.body(id);b.setTranslation(add(b.translation(),V(0,0,.6)),true);b.setLinvel(V(),true);}w.state.truck.grips=[];
  step(w,180);const up=rotate(deck.rotation(),V(0,1,0)),shiftedRoll=Math.atan2(up.z,up.y);
  evidence('P12-ferry-heel',{initialRoll,shiftedRoll,rollChange:shiftedRoll-initialRoll,physicalCargoOffset:.6,platformPosition:{...deck.translation()}});
  expect(Math.abs(shiftedRoll-initialRoll)).toBeGreaterThan(.015);
 }finally{w.dispose();}
});
it('P13 real third-map truck, six capsules and barriers rise on the force-limited lift',async()=>{
 const w=await TyagaWorld.create({matchId:'lift-physical-fixture',mapId:'ridge',mode:'practice',participants:crew});try{
  const lift=w.state.machinery.lift!;place(w,'lift-drive',V(221.45,16.7,69.3));w.addLink('ferry-lock','lift-transmission','drive','lift-drive','drive');lift.driveId='lift-drive';
  for(const id of Object.keys(lift.barriers)){lift.barriers[id]=true;for(const h of w.state.entities[id].colliders)w.physics.getCollider(h).setCollisionGroups(0xffffffff);}
  moveLoadedTruck(w,V(222,11.2,72));
  for(const[i,p]of crew.entries())place(w,`person:${p.participantId}`,V(222+[-2.8,0,2.8][Math.floor(i/2)],11.08,72+(i%2?1.7:-1.7)));
  step(w,120);const start=w.body('lift-platform').translation().y;const mass=w.liftLoad();
  w.state.characters['person-1'].controlling='lift-platform';lift.operator='person-1';
  step(w,600,{'person-1':{...NEUTRAL_INPUT,tool:1}});const raised=w.body('lift-platform').translation().y;
  step(w,180,{'person-1':{...NEUTRAL_INPUT}});const stopped=w.body('lift-platform').translation().y;
  w.releaseCharacter('person-1');step(w,180);const neutral=w.body('lift-platform').translation().y;
  evidence('P13-lift',{assemblyMass:mass,platformAndBarriers:520,payload:mass-520,start,raised,stopped,neutral,rise:raised-start,liftBroken:lift.cableBroken,crew:crew.map(p=>({id:p.participantId,position:{...w.body(`person:${p.participantId}`).translation()}}))});
  expect(mass).toBeCloseTo(3937,0);expect(raised-start).toBeGreaterThan(1.1);expect(raised-start).toBeLessThan(1.3);expect(Math.abs(stopped-neutral)).toBeLessThan(.03);expect(lift.cableBroken).toBe(false);
  w.state.characters['person-1'].controlling='lift-platform';lift.operator='person-1';step(w,2600,{'person-1':{...NEUTRAL_INPUT,tool:1}});
  const top=w.body('lift-platform').translation().y;
  const contacts:unknown[]=[];
  for(const e of Object.values(w.state.entities).filter(e=>e.active&&!e.fixed)){
    for(const h of e.colliders){
      w.physics.contactPairsWith(w.physics.getCollider(h),other=>{
        const oid=w.state.colliderBodies[other.handle];
        if(!w.state.entities[oid]||w.state.entities[oid].fixed){
          w.physics.contactPair(w.physics.getCollider(h),other,m=>{
            if(m.numSolverContacts()>0)contacts.push({id:e.id,other:oid,normal:{...m.normal()},points:Array.from({length:m.numContacts()},(_,i)=>({impulse:m.contactImpulse(i),dist:m.contactDist(i)}))});
          });
        }
      });
    }
  }
  evidence('P13-full-debug',{top,lift,load:w.liftLoad(),phase:w.state.phase,events:w.state.events,contacts});
  console.log('LIFT_FULL',top,lift,w.liftLoad(),w.state.phase,contacts);
  expect(top).toBeGreaterThan(16.05);expect(top).toBeLessThan(16.15);
  w.releaseCharacter('person-1');const beforeCatch=top;
  w.addBody({id:'overload-fixture',kind:'block',position:V(218.45,16.8,72),mass:6500,size:V(.8,.8,1)});step(w,180);
  const caught=w.body('lift-platform').translation().y;
  evidence('P13-full-travel-and-catch',{top,beforeCatch,caught,drop:beforeCatch-caught,dropAfterBreak:(lift.catchHeight??beforeCatch)-caught,broken:lift.cableBroken,catchHeight:lift.catchHeight});
  expect(lift.cableBroken).toBe(true);expect((lift.catchHeight??beforeCatch)-caught).toBeLessThan(.151);

 }finally{w.dispose();}
});
