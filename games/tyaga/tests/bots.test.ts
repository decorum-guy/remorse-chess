import { expect, it } from 'vitest';
import { TyagaWorld } from '../src/server-world/world';
import { NEUTRAL_INPUT } from '../src/core/config';
import { V, distance } from '../src/core/math';
import { evidence } from './evidence';
it('a helper reaches the real free deck handle and cooperates through normal commands',async()=>{
 const w=await TyagaWorld.create({matchId:'bot-carry',mapId:'tutorial',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'helper',displayName:'Helper',seatIndex:1,bot:true}]});
 try{
  w.body('person:human').setTranslation(V(17,.9,22),true);for(let i=0;i<10;i++)w.step();
  expect(w.action('human',{type:'grab',itemId:'training-heavy',handleId:'handle-0'}).result.ok).toBe(true);
  expect(w.action('human',{type:'bot-order',participantId:'helper',task:'carry',targetId:'training-heavy'}).result.ok).toBe(true);
  let arrived=-1;for(let i=0;i<1200;i++){w.step();if(w.state.characters.helper.holding?.itemId==='training-heavy'){arrived=i/60;break;}}
  evidence('bot-approach',{arrived,actor:w.view('helper').entities.find(e=>e.id==='person:helper'),task:w.state.characters.helper.task,memory:w.state.characters.helper.botMemory,events:w.state.events,interactions:w.view('helper').interactions.filter(i=>i.targetId==='training-heavy')});expect(w.state.characters.helper.holding?.itemId).toBe('training-heavy');const before={...w.body('training-heavy').translation()};
  const trace:unknown[]=[];for(let i=0;i<90;i++){w.step({human:{...NEUTRAL_INPUT,moveX:1}});if(i%6===0)trace.push({i,deck:{...w.body('training-heavy').translation()},actors:Object.fromEntries(Object.entries(w.state.characters).map(([id,c])=>[id,{p:{...w.body(c.bodyId).translation()},velocity:{...w.body(c.bodyId).linvel()},holding:c.holding,handle:c.holding?w.socket(c.holding.itemId,c.holding.handleId)?.world:null,input:w.inputs[id]}]))});}const after={...w.body('training-heavy').translation()};
  evidence('bot-carry',{arrivedSeconds:arrived,before,after,displacement:distance(before,after),holders:Object.values(w.state.characters).filter(c=>c.holding?.itemId==='training-heavy').length,helperTask:w.state.characters.helper.task,trace,events:w.state.events});
  expect(distance(before,after)).toBeGreaterThan(.7);expect(w.state.characters.helper.holding?.itemId).toBe('training-heavy');
 }finally{w.dispose();}
});

it('an ordered driver enters, releases parking brake, drives to a nearby marker and stops',async()=>{
 const w=await TyagaWorld.create({matchId:'bot-drive',mapId:'tutorial',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'helper',displayName:'Driver',seatIndex:1,bot:true,botProfile:'driver'}]});
 try{
  const start={...w.body('truck').translation()};
  expect(w.action('human',{type:'bot-order',participantId:'helper',task:'drive',point:V(22,0,18)}).result.ok).toBe(true);
  let completed=-1;for(let i=0;i<1800;i++){w.step();if(w.state.characters.helper.task?.status==='completed'){completed=i/60;break;}}
  evidence('bot-drive',{completedSeconds:completed,start,end:{...w.body('truck').translation()},task:w.state.characters.helper.task,truck:w.view('human').truck,events:w.state.events});
  expect(completed).toBeGreaterThan(0);expect(w.body('truck').translation().x-start.x).toBeGreaterThan(7.5);expect(w.state.truck.brake).toBe(true);expect(w.state.truck.driver).toBeNull();
 }finally{w.dispose();}
});

it('R03 stationary opposite-side grips do not create a self-propelled orbit or release loop',async()=>{
 const w=await TyagaWorld.create({matchId:'bot-stationary-R03',mapId:'tutorial',participants:[{participantId:'human',displayName:'Human',seatIndex:0,bot:false},{participantId:'helper',displayName:'Helper',seatIndex:1,bot:true}]});
 try{
  w.body('person:human').setTranslation(V(16.884,.875,26.595),true);for(let i=0;i<600;i++)w.step();
  expect(w.action('human',{type:'grab',itemId:'training-heavy',handleId:'handle-1'}).result.ok).toBe(true);
  expect(w.action('human',{type:'bot-order',participantId:'helper',task:'carry',targetId:'training-heavy'}).result.ok).toBe(true);
  let arrived=-1;for(let i=0;i<1200;i++){w.step();if(w.state.characters.helper.holding?.itemId==='training-heavy'){arrived=i/60;break;}}
  expect(arrived).toBeGreaterThan(0);for(let i=0;i<120;i++)w.step();const before={...w.body('training-heavy').translation()};
  let maximumDrift=0,losses=0;for(let i=0;i<1800;i++){w.step();const p=w.body('training-heavy').translation();maximumDrift=Math.max(maximumDrift,Math.hypot(p.x-before.x,p.z-before.z));if(!w.state.characters.human.holding||!w.state.characters.helper.holding)losses++;}
  evidence('bot-stationary-R03',{arrivedSeconds:arrived,stationarySeconds:30,maximumDrift,losses,before,after:{...w.body('training-heavy').translation()},humans:Object.fromEntries(Object.entries(w.state.characters).map(([id,c])=>[id,{holding:c.holding,position:{...w.body(c.bodyId).translation()}}])),events:w.state.events});
  expect(losses).toBe(0);expect(maximumDrift).toBeLessThan(.2);
  const moveStart={...w.body('training-heavy').translation()};for(let i=0;i<90;i++)w.step({human:{...NEUTRAL_INPUT,moveX:1}});expect(distance(moveStart,w.body('training-heavy').translation())).toBeGreaterThan(.6);expect(w.state.characters.helper.holding?.itemId).toBe('training-heavy');
 }finally{w.dispose();}
});
