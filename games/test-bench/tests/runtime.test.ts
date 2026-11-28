import { mkdtempSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe,expect,it } from 'vitest';
import type { Participant,StartMatchRequest } from '@iva-games/session-kit';
import { PRESETS } from '../src/catalog';
import { TestBenchRuntime } from '../src/runtime';
import { BOT_VERSION,CONTENT_VERSION,RULES_VERSION,STEP } from '../src/types';
import type { BenchAction,BenchView } from '../src/types';

const players:Participant[]=[
  {participantId:'seat-a',playerId:'human-a',displayName:'Ada',seatIndex:0,controller:{kind:'human',playerId:'human-a'}},
  {participantId:'seat-b',playerId:'human-b',displayName:'Ben',seatIndex:1,controller:{kind:'human',playerId:'human-b'}},
  {participantId:'seat-c',playerId:null,displayName:'Bot',seatIndex:2,controller:{kind:'bot',botProfileId:'test-bench:normal',botVersion:BOT_VERSION,difficulty:'normal'}},
];
const request=(participants=players):StartMatchRequest=>({startCommandId:'start-one',roomId:'room-one',rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,participants,settings:{}});
describe('durable authoritative runtime',()=>{
  it('starts idempotently, hides other drafts and rejects replay conflicts and stale edits',async()=>{
    const runtime=new TestBenchRuntime({databasePath:':memory:',autoTick:false,now:()=>0});
    try{
      const {matchId}=await runtime.createMatch(request());expect(await runtime.createMatch(request())).toEqual({matchId});
      await expect(runtime.createMatch({...request(),settings:{different:true}})).rejects.toMatchObject({code:'START_CONFLICT'});
      await expect(runtime.viewForPlayer(matchId,'outsider')).rejects.toMatchObject({code:'FORBIDDEN'});
      let view=await runtime.viewForPlayer(matchId,'human-a');
      for(const player of ['human-a','human-b']){view=await runtime.viewForPlayer(matchId,player);await runtime.applyAction(matchId,player,{actionId:`confirm-${player}`,expectedRevision:view.revision,payload:{type:'confirm',phaseId:view.phaseId}});}
      view=await runtime.viewForPlayer(matchId,'human-a');expect(view.phase).toBe('building');
      const command={actionId:'build-one',expectedRevision:view.revision,payload:{type:'blueprint',phaseId:view.phaseId,buildRevision:0,blueprint:PRESETS.tractor}};
      const accepted=await runtime.applyAction(matchId,'human-a',command);expect(accepted.you.budget).toBe(15);
      expect((await runtime.applyAction(matchId,'human-a',command)).you.build.revision).toBe(1);
      await expect(runtime.applyAction(matchId,'human-a',{...command,payload:{...command.payload,blueprint:PRESETS.gentle}})).rejects.toMatchObject({code:'ACTION_CONFLICT'});
      const opponent=await runtime.viewForPlayer(matchId,'human-b');expect(opponent.players.find(p=>p.playerId==='human-a')?.blueprint).toBeNull();expect(opponent.you.build.blueprint).toEqual(PRESETS.universal);
      await expect(runtime.applyAction(matchId,'human-a',{...command,actionId:'stale'})).rejects.toMatchObject({code:'STALE_BUILD'});
      await expect(runtime.applyAction(matchId,'human-a',{...command,actionId:'bad-phase',payload:{...command.payload,phaseId:1}})).rejects.toMatchObject({code:'WRONG_PHASE'});
      expect((await runtime.viewForPlayer(matchId,'human-a')).you.build.blueprint).toEqual(PRESETS.tractor);
    }finally{await runtime.close();}
  });
  it('allows concurrent seats to submit independently while rejecting a stale draft revision',async()=>{
    const runtime=new TestBenchRuntime({databasePath:':memory:',autoTick:false,now:()=>0});
    try{
      const {matchId}=await runtime.createMatch(request());
      for(const playerId of ['human-a','human-b']){const view=await runtime.viewForPlayer(matchId,playerId);await runtime.applyAction(matchId,playerId,{actionId:`confirm-${playerId}`,expectedRevision:view.revision,payload:{type:'confirm',phaseId:view.phaseId}});}
      const a=await runtime.viewForPlayer(matchId,'human-a');const b=await runtime.viewForPlayer(matchId,'human-b');
      await runtime.applyAction(matchId,'human-a',{actionId:'parallel-a',expectedRevision:a.revision,payload:{type:'blueprint',phaseId:a.phaseId,buildRevision:a.you.build.revision,blueprint:PRESETS.tractor}});
      const updated=await runtime.applyAction(matchId,'human-b',{actionId:'parallel-b',expectedRevision:b.revision,payload:{type:'blueprint',phaseId:b.phaseId,buildRevision:b.you.build.revision,blueprint:PRESETS.gentle}});
      expect(updated.you.build.blueprint).toEqual(PRESETS.gentle);expect(updated.revision).toBeGreaterThan(b.revision);
      await expect(runtime.applyAction(matchId,'human-b',{actionId:'stale-b',expectedRevision:updated.revision,payload:{type:'blueprint',phaseId:b.phaseId,buildRevision:b.you.build.revision,blueprint:PRESETS.universal}})).rejects.toMatchObject({code:'STALE_BUILD'});
      expect((await runtime.viewForPlayer(matchId,'human-a')).you.build.blueprint).toEqual(PRESETS.tractor);
    }finally{await runtime.close();}
  });
  it('admits at most three active cups per production owner without blocking start replay',async()=>{
    const runtime=new TestBenchRuntime({databasePath:':memory:',autoTick:false,now:()=>0,shard:{index:0,count:2}});
    try{
      const first=request([players[0],players[2]]);const match=await runtime.createMatch(first);
      for(let i=1;i<3;i++)await runtime.createMatch({...first,startCommandId:`start-${i}`,roomId:`room-${i}`});
      await expect(runtime.createMatch({...first,startCommandId:'start-overflow',roomId:'room-overflow'})).rejects.toMatchObject({code:'GAME_BUSY',statusCode:503});
      expect(await runtime.createMatch(first)).toEqual(match);expect(match.matchId).toMatch(/^tb0_/);
    }finally{await runtime.close();}
  });
  it('replaces epochs, ignores old inputs, brakes on silence and keeps old disconnect from clearing new control',async()=>{
    let now=1000;const runtime=new TestBenchRuntime({databasePath:':memory:',autoTick:false,now:()=>now});
    const advance=async(n:number)=>{now+=n*STEP*1000;await runtime.advanceSimulation(n);};
    try{
      const {matchId}=await runtime.createMatch(request([players[0],players[2]]));
      let view=await runtime.viewForPlayer(matchId,'human-a');view=await runtime.applyAction(matchId,'human-a',{actionId:'confirm',expectedRevision:view.revision,payload:{type:'confirm',phaseId:view.phaseId}});
      view=await runtime.applyAction(matchId,'human-a',{actionId:'ready',expectedRevision:view.revision,payload:{type:'ready',ready:true,phaseId:view.phaseId}});await advance(241);
      view=await runtime.viewForPlayer(matchId,'human-a');expect(view.phase).toBe('racing');
      await runtime.liveConnect(matchId,'human-a','old');await runtime.liveConnect(matchId,'human-a','new');await runtime.liveDisconnect(matchId,'human-a','old');
      await expect(runtime.liveInput(matchId,'human-a',{epoch:'old',seq:1,payload:{phaseId:view.phaseId,throttle:1,steering:0,brake:false}})).rejects.toMatchObject({code:'STALE_CONTROL'});
      await runtime.liveInput(matchId,'human-a',{epoch:'new',seq:1,payload:{phaseId:view.phaseId,throttle:1,steering:0,brake:false}});await advance(10);
      const driving=(await runtime.viewForPlayer(matchId,'human-a')).you.lane!;expect(driving.car.speed).toBeGreaterThan(0.1);
      await runtime.liveInput(matchId,'human-a',{epoch:'new',seq:0,payload:{phaseId:view.phaseId,throttle:-1,steering:1,brake:false}});
      expect((await runtime.liveSnapshot(matchId,'human-a','new')).lastAcceptedSeq).toBe(1);
      await advance(180);const stopped=(await runtime.viewForPlayer(matchId,'human-a')).you.lane!;expect(stopped.car.speed).toBeLessThan(0.1);
    }finally{await runtime.close();}
  });
  it('persists discrete actions and phase time, resumes after five seconds and finishes a three-stage cup',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'iva-test-bench-'));const path=join(directory,'bench.sqlite');let now=1000;
    let runtime=new TestBenchRuntime({databasePath:path,autoTick:false,now:()=>now});let actionId=0;
    const action=async(matchId:string,payload:BenchAction):Promise<BenchView>=>{const v=await runtime.viewForPlayer(matchId,'human-a');return runtime.applyAction(matchId,'human-a',{actionId:`command-${++actionId}`,expectedRevision:v.revision,payload});};
    const advance=async(n:number)=>{now+=n*STEP*1000;await runtime.advanceSimulation(n);};
    try{
      const {matchId}=await runtime.createMatch(request([players[0],players[2]]));let view=await runtime.viewForPlayer(matchId,'human-a');view=await action(matchId,{type:'confirm',phaseId:view.phaseId});
      view=await action(matchId,{type:'blueprint',phaseId:view.phaseId,buildRevision:view.you.build.revision,blueprint:{...PRESETS.universal,'aux-left':'ballast'}});
      view=await action(matchId,{type:'ready',ready:true,phaseId:view.phaseId});await advance(241);view=await runtime.viewForPlayer(matchId,'human-a');expect(view.phase).toBe('racing');
      const restore={actionId:'durable-restore',expectedRevision:view.revision,payload:{type:'restore',phaseId:view.phaseId}};
      view=await runtime.applyAction(matchId,'human-a',restore);expect(view.you.lane?.resets).toBe(1);const savedCharge=view.you.lane!.car.charge;const savedTick=view.you.lane!.tick;const remaining=view.phaseEndsAt-now;
      await runtime.close();now+=60000;runtime=new TestBenchRuntime({databasePath:path,autoTick:false,now:()=>now});
      view=await runtime.viewForPlayer(matchId,'human-a');expect(view.phase).toBe('recovering');expect(view.you.lane?.resets).toBe(1);expect(view.you.lane?.tick).toBe(savedTick);expect(view.you.lane?.car.charge).toBe(savedCharge);
      view=await runtime.applyAction(matchId,'human-a',restore);expect(view.you.lane?.resets).toBe(1);
      await advance(301);view=await runtime.viewForPlayer(matchId,'human-a');expect(view.phase).toBe('racing');expect(Math.abs((view.phaseEndsAt-now)-remaining)).toBeLessThanOrEqual(STEP*1000+0.01);
      await advance(3900);view=await runtime.viewForPlayer(matchId,'human-a');expect(view.phase).toBe('debrief');expect(view.stages[0].results.find(r=>r.participantId==='seat-a')?.points).toBe(0);
      view=await action(matchId,{type:'confirm',phaseId:view.phaseId});view=await action(matchId,{type:'confirm',phaseId:view.phaseId});expect(view.phase).toBe('building');
      const moved={...view.you.build.blueprint,'aux-left':null,'aux-right':'ballast'} as const;view=await action(matchId,{type:'blueprint',phaseId:view.phaseId,buildRevision:view.you.build.revision,blueprint:moved});expect(view.you.edits).toBe(2);
      await expect(action(matchId,{type:'blueprint',phaseId:view.phaseId,buildRevision:view.you.build.revision,blueprint:{...moved,motor:'torque'}})).rejects.toMatchObject({code:'TOO_MANY_EDITS'});
      for(let stage=1;stage<3;stage++){
        view=await action(matchId,{type:'ready',ready:true,phaseId:view.phaseId});await advance(241+3900);view=await runtime.viewForPlayer(matchId,'human-a');expect(view.phase).toBe('debrief');view=await action(matchId,{type:'confirm',phaseId:view.phaseId});if(stage<2)view=await action(matchId,{type:'confirm',phaseId:view.phaseId});
      }
      expect(view.phase).toBe('finished');expect(view.stages).toHaveLength(3);expect((await runtime.status(matchId)).finished).toBe(true);
      await runtime.close();runtime=new TestBenchRuntime({databasePath:path,autoTick:false,now:()=>now+100000});expect((await runtime.viewForPlayer(matchId,'human-a')).standings).toEqual(view.standings);
    }finally{await runtime.close();rmSync(directory,{recursive:true,force:true});}
  },30000);
});
