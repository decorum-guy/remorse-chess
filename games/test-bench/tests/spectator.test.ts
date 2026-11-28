import {expect,it} from 'vitest';
import type {Participant} from '@iva-games/session-kit';
import {chooseBotInput} from '../src/bots';
import {TestBenchRuntime} from '../src/runtime';
import {BOT_VERSION,CONTENT_VERSION,RULES_VERSION,STEP} from '../src/types';

it('sends one selected spectator lane only after finishing and returns to the own lane next stage',async()=>{
  let now=1000;const runtime=new TestBenchRuntime({databasePath:':memory:',autoTick:false,now:()=>now});let actionId=0;
  const participants:Participant[]=[
    {participantId:'a',playerId:'alice',displayName:'Alice',seatIndex:0,controller:{kind:'human',playerId:'alice'}},
    {participantId:'b',playerId:'bob',displayName:'Bob',seatIndex:1,controller:{kind:'human',playerId:'bob'}},
    {participantId:'c',playerId:null,displayName:'Bot',seatIndex:2,controller:{kind:'bot',botProfileId:'test-bench:normal',botVersion:BOT_VERSION,difficulty:'normal'}},
  ];
  try{
    const {matchId}=await runtime.createMatch({startCommandId:'start',roomId:'room',rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,participants,settings:{}});
    const both=async(type:'confirm'|'ready')=>{for(const playerId of ['alice','bob']){const view=await runtime.viewForPlayer(matchId,playerId);await runtime.applyAction(matchId,playerId,{actionId:`action-${++actionId}`,expectedRevision:view.revision,payload:type==='ready'?{type,phaseId:view.phaseId,ready:true}:{type,phaseId:view.phaseId}});}};
    const advance=async(ticks:number)=>{now+=ticks*STEP*1000;await runtime.advanceSimulation(ticks);};
    await both('confirm');await both('ready');await advance(241);await runtime.liveConnect(matchId,'alice','epoch');let view=await runtime.viewForPlayer(matchId,'alice'),seq=0;
    await runtime.liveInput(matchId,'alice',{epoch:'epoch',seq:++seq,payload:{phaseId:view.phaseId,throttle:0,steering:0,brake:true,watchParticipantId:'b'}});
    expect((await runtime.viewForPlayer(matchId,'alice')).spectatingId).toBeNull();
    for(let tick=0;tick<3900&&!view.you.lane!.finished;tick++){
      const decision=chooseBotInput(view.you.lane!,view.track,'normal');
      if(decision.interact)await runtime.applyAction(matchId,'alice',{actionId:`load-${++actionId}`,expectedRevision:view.revision,payload:{type:'interact',phaseId:view.phaseId}});
      await runtime.liveInput(matchId,'alice',{epoch:'epoch',seq:++seq,payload:{...decision.input,phaseId:view.phaseId}});await advance(1);view=await runtime.viewForPlayer(matchId,'alice');
    }
    expect(view.phase).toBe('racing');expect(view.you.lane?.result?.finished).toBe(true);
    await runtime.liveInput(matchId,'alice',{epoch:'epoch',seq:++seq,payload:{phaseId:view.phaseId,watchParticipantId:'outsider'}});expect((await runtime.viewForPlayer(matchId,'alice')).spectatingId).toBeNull();
    await runtime.liveInput(matchId,'alice',{epoch:'epoch',seq:++seq,payload:{phaseId:view.phaseId,watchParticipantId:'b'}});view=await runtime.viewForPlayer(matchId,'alice');
    expect(view.spectatingId).toBe('b');expect(view.players.filter(player=>player.lane!==null).map(player=>player.participantId)).toEqual(['b']);expect(view.stages).toEqual([]);
    do{await advance(60);view=await runtime.viewForPlayer(matchId,'alice');}while(view.phase==='racing');expect(view.phase).toBe('debrief');await both('confirm');await both('confirm');await both('ready');view=await runtime.viewForPlayer(matchId,'alice');expect(view.phase).toBe('countdown');expect(view.spectatingId).toBeNull();expect(view.players.every(player=>player.lane===null)).toBe(true);
    await advance(241);expect((await runtime.viewForPlayer(matchId,'alice')).spectatingId).toBeNull();
  }finally{await runtime.close();}
});
