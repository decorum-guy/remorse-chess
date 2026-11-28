import { expect,it,vi } from 'vitest';
import { PRESETS } from '../src/catalog';
import { TestBenchRuntime } from '../src/runtime';
import { BenchStore } from '../src/store';
import { BOT_VERSION,CONTENT_VERSION,RULES_VERSION } from '../src/types';

it('quarantines a failed atomic write, restores durable physics/state and never acknowledges the rejected blueprint',async()=>{
  let now=1000;const runtime=new TestBenchRuntime({databasePath:':memory:',autoTick:false,now:()=>now});
  try{
    const {matchId}=await runtime.createMatch({startCommandId:'start',roomId:'room',rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,settings:{},participants:[{participantId:'human',playerId:'player',displayName:'Player',seatIndex:0,controller:{kind:'human',playerId:'player'}},{participantId:'bot',playerId:null,displayName:'Bot',seatIndex:1,controller:{kind:'bot',botProfileId:'test-bench:normal',botVersion:BOT_VERSION,difficulty:'normal'}}]});
    let view=await runtime.viewForPlayer(matchId,'player');view=await runtime.applyAction(matchId,'player',{actionId:'confirm',expectedRevision:view.revision,payload:{type:'confirm',phaseId:view.phaseId}});
    const failed=vi.spyOn(BenchStore.prototype,'saveWithReceipt').mockImplementationOnce(()=>{throw new Error('SQLITE_FULL');});
    await expect(runtime.applyAction(matchId,'player',{actionId:'build',expectedRevision:view.revision,payload:{type:'blueprint',phaseId:view.phaseId,buildRevision:view.you.build.revision,blueprint:PRESETS.tractor}})).rejects.toMatchObject({code:'UNAVAILABLE'});failed.mockRestore();
    view=await runtime.viewForPlayer(matchId,'player');expect(view.phase).toBe('recovering');expect(view.you.build.blueprint).toEqual(PRESETS.universal);
    now+=5017;await runtime.advanceSimulation(301);view=await runtime.viewForPlayer(matchId,'player');expect(view.phase).toBe('building');
    view=await runtime.applyAction(matchId,'player',{actionId:'build',expectedRevision:view.revision,payload:{type:'blueprint',phaseId:view.phaseId,buildRevision:view.you.build.revision,blueprint:PRESETS.tractor}});expect(view.you.build.blueprint).toEqual(PRESETS.tractor);expect(view.you.build.revision).toBe(1);
    const originalSave=BenchStore.prototype.save;let writes=0;const phaseFailure=vi.spyOn(BenchStore.prototype,'save').mockImplementation(function(this:BenchStore,state){writes++;if(writes===2)throw new Error('SQLITE_BUSY');return originalSave.call(this,state);});
    const ready={actionId:'ready',expectedRevision:view.revision,payload:{type:'ready',phaseId:view.phaseId,ready:true}};
    await expect(runtime.applyAction(matchId,'player',ready)).rejects.toMatchObject({code:'UNAVAILABLE'});phaseFailure.mockRestore();
    view=await runtime.viewForPlayer(matchId,'player');expect(view.phase).toBe('recovering');expect(view.you.build.ready).toBe(true);view=await runtime.applyAction(matchId,'player',ready);expect(view.you.build.ready).toBe(true);expect(view.phase).toBe('recovering');now+=5050;await runtime.advanceSimulation(303);view=await runtime.viewForPlayer(matchId,'player');expect(view.phase).toBe('countdown');expect(view.you.build.blueprint).toEqual(PRESETS.tractor);
  }finally{vi.restoreAllMocks();await runtime.close();}
});
