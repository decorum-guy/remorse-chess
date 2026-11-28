import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect,it } from 'vitest';
import type { Participant } from '@iva-games/session-kit';
import { TestBenchRuntime } from '../src/runtime';
import { BOT_VERSION,CONTENT_VERSION,RULES_VERSION,STEP } from '../src/types';

it('profiles the admitted three six-seat rooms per owner including on-disk checkpoints',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'iva-bench-owner-profile-'));let now=1000;const runtime=new TestBenchRuntime({databasePath:join(directory,'games.sqlite'),autoTick:false,now:()=>now,shard:{index:0,count:2}});
  try{
    for(let room=0;room<3;room++){
      const participants:Participant[]=[{participantId:`human-seat-${room}`,playerId:`human-${room}`,displayName:'Human',seatIndex:0,controller:{kind:'human',playerId:`human-${room}`}},...Array.from({length:5},(_,i):Participant=>({participantId:`bot-${room}-${i}`,playerId:null,displayName:`Bot ${i}`,seatIndex:i+1,controller:{kind:'bot',botProfileId:'test-bench:normal',botVersion:BOT_VERSION,difficulty:'normal'}}))];
      const {matchId}=await runtime.createMatch({startCommandId:`start-${room}`,roomId:`room-${room}`,rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,participants,settings:{}});
      let view=await runtime.viewForPlayer(matchId,`human-${room}`);view=await runtime.applyAction(matchId,`human-${room}`,{actionId:`confirm-${room}`,expectedRevision:view.revision,payload:{type:'confirm',phaseId:view.phaseId}});await runtime.applyAction(matchId,`human-${room}`,{actionId:`ready-${room}`,expectedRevision:view.revision,payload:{type:'ready',ready:true,phaseId:view.phaseId}});
    }
    const samples:number[]=[];
    for(let tick=0;tick<720;tick++){now+=STEP*1000;const start=performance.now();await runtime.advanceSimulation(1);samples.push(performance.now()-start);}
    samples.sort((a,b)=>a-b);const report={rooms:3,seats:18,bots:15,productionOwners:2,simulationSteps:720,ownerMetrics:await runtime.ownerMetrics(),p50Ms:samples[360],p95Ms:samples[Math.floor(samples.length*.95)],p99Ms:samples[Math.floor(samples.length*.99)],maxMs:samples.at(-1),environment:'Node Linux; one production-sized owner with on-disk SQLite WAL; includes snapshot serialization and synchronous writes; six-room/two-owner wall-clock evidence is worker-profile.json'};
    mkdirSync('.qa/test-bench',{recursive:true});writeFileSync('.qa/test-bench/load-owner-profile.json',JSON.stringify(report,null,2));expect(report.p95Ms).toBeLessThan(12.525);
  }finally{await runtime.close();rmSync(directory,{recursive:true,force:true});}
},60000);
