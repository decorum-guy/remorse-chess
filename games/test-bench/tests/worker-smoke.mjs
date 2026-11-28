import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const directory=mkdtempSync(join(tmpdir(),'iva-bench-workers-'));
const databasePath=join(directory,'games.sqlite');
const entry=pathToFileURL(resolve('dist-platform/test-bench-worker.js'));
let sequence=0;
function owner(index){
  const worker=new Worker(entry,{workerData:{databasePath,shard:{index,count:2}}});
  const pending=new Map();let resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  worker.on('message',message=>{if(message.ready){resolveReady();return;}const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);clearTimeout(waiter.timer);if(message.error)waiter.reject(Object.assign(new Error(message.error.message),message.error));else waiter.resolve(message.value);});
  worker.on('error',error=>{rejectReady(error);for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}pending.clear();});
  return {worker,ready,async call(method,...args){await ready;const id=++sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Worker timeout: ${method}`));},10000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,method,args});});},async close(){try{await this.call('close');}finally{await worker.terminate();}}};
}
const owners=[owner(0),owner(1)];
const loop=monitorEventLoopDelay({resolution:5});
const roomRecords=[];let inputTimer;let inputTask=Promise.resolve();let inputError;let inputsInFlight=false,inputSeq=0;
try{
  await Promise.all(owners.map(w=>w.ready));
  for(let room=0;room<6;room++){
    const worker=owners[room%2];const playerId=`human-${room}`;
    const participants=[{participantId:`human-seat-${room}`,playerId,displayName:'Human',seatIndex:0,controller:{kind:'human',playerId}},...Array.from({length:5},(_,i)=>({participantId:`bot-${room}-${i}`,playerId:null,displayName:`Bot ${i+1}`,seatIndex:i+1,controller:{kind:'bot',botProfileId:'test-bench:normal',botVersion:'test-bench-bot@1',difficulty:'normal'}}))];
    const {matchId}=await worker.call('createMatch',{startCommandId:`start-${room}`,roomId:`room-${room}`,rulesVersion:'test-bench@1',contentVersion:'test-bench-content@1',participants,settings:{}});assert.ok(matchId.startsWith(`tb${room%2}_`));
    let view=await worker.call('viewForPlayer',matchId,playerId);view=await worker.call('applyAction',matchId,playerId,{actionId:'confirm',expectedRevision:view.revision,payload:{type:'confirm',phaseId:view.phaseId}});view=await worker.call('applyAction',matchId,playerId,{actionId:'ready',expectedRevision:view.revision,payload:{type:'ready',phaseId:view.phaseId,ready:true}});
    assert.equal(view.phase,'countdown');await worker.call('liveConnect',matchId,playerId,`epoch-${room}`);roomRecords.push({matchId,playerId,index:room%2,phaseId:view.phaseId});
  }
  for(const worker of owners)await assert.rejects(worker.call('createMatch',{startCommandId:'overflow',roomId:'overflow',rulesVersion:'test-bench@1',contentVersion:'test-bench-content@1',participants:[{participantId:'a',playerId:'a',displayName:'A',seatIndex:0,controller:{kind:'human',playerId:'a'}},{participantId:'b',playerId:'b',displayName:'B',seatIndex:1,controller:{kind:'human',playerId:'b'}}],settings:{}}),error=>error.code==='GAME_BUSY');
  const snapshots=()=>Promise.all(roomRecords.map(record=>owners[record.index].call('liveSnapshot',record.matchId,record.playerId,`epoch-${Number(record.playerId.split('-')[1])}`)));
  let first=await snapshots();
  const readyDeadline=performance.now()+6000;
  while(first.some(snapshot=>snapshot.view.phase!=='racing')){assert.ok(performance.now()<readyDeadline,'All matches must begin racing');await new Promise(resolve=>setTimeout(resolve,100));first=await snapshots();}
  await Promise.all(owners.map(worker=>worker.call('ownerMetrics',true)));
  first=await snapshots();let last=first;loop.enable();const viewBytes=[];const start=performance.now();
  inputTimer=setInterval(()=>{if(inputsInFlight)return;inputsInFlight=true;const seq=++inputSeq;inputTask=Promise.all(roomRecords.map((record,index)=>owners[record.index].call('liveInput',record.matchId,record.playerId,{epoch:`epoch-${Number(record.playerId.split('-')[1])}`,seq,payload:{phaseId:first[index].view.phaseId,throttle:0,steering:0,brake:true}}))).catch(error=>{inputError=error;}).finally(()=>{inputsInFlight=false;});},34);
  for(let sample=0;sample<150;sample++){
    await new Promise(resolve=>setTimeout(resolve,66));last=await snapshots();
    viewBytes.push(...last.map(snapshot=>Buffer.byteLength(JSON.stringify(snapshot.view))));
  }
  const measuredMs=performance.now()-start;loop.disable();clearInterval(inputTimer);await inputTask;if(inputError)throw inputError;
  const ownerMetrics=await Promise.all(owners.map(worker=>worker.call('ownerMetrics')));
  const tickAdvancement=last.map((snapshot,index)=>({matchId:roomRecords[index].matchId,owner:roomRecords[index].index,advanced:snapshot.tick-first[index].tick,expectedAt60Hz:measuredMs*.06,lagTicks:measuredMs*.06-(snapshot.tick-first[index].tick),phase:snapshot.view.phase}));
  const target=roomRecords[0];let view=await owners[0].call('viewForPlayer',target.matchId,target.playerId);assert.equal(view.phase,'racing');
  const reset={actionId:'reset-before-crash',expectedRevision:view.revision,payload:{type:'restore',phaseId:view.phaseId}};
  view=await owners[0].call('applyAction',target.matchId,target.playerId,reset);assert.equal(view.you.lane.resets,1);const savedTick=view.you.lane.tick;
  await owners[0].worker.terminate();owners[0]=owner(0);await owners[0].ready;
  view=await owners[0].call('viewForPlayer',target.matchId,target.playerId);assert.equal(view.phase,'recovering');assert.equal(view.you.lane.resets,1);assert.ok(view.you.lane.tick>=savedTick);
  const repeated=await owners[0].call('applyAction',target.matchId,target.playerId,reset);assert.equal(repeated.you.lane.resets,1);
  await owners[0].call('liveConnect',target.matchId,target.playerId,'fresh-epoch');
  await assert.rejects(owners[0].call('liveSnapshot',target.matchId,target.playerId,'epoch-0'),error=>error.code==='STALE_CONTROL');
  const fresh=await owners[0].call('liveSnapshot',target.matchId,target.playerId,'fresh-epoch');assert.equal(fresh.view.phase,'recovering');assert.equal(fresh.lastAcceptedSeq,-1);
  await new Promise(resolve=>setTimeout(resolve,5200));view=await owners[0].call('viewForPlayer',target.matchId,target.playerId);assert.equal(view.phase,'racing');
  const report={build:{workerEntry:'dist-platform/test-bench-worker.js',workerSha256:createHash('sha256').update(readFileSync(entry)).digest('hex')},rooms:6,seats:36,bots:30,workers:2,database:'Shared SQLite WAL; one owner per shard',measurementMs:measuredMs,parentEventLoopP95Ms:loop.percentile(95)/1e6,parentEventLoopP99Ms:loop.percentile(99)/1e6,parentEventLoopMaxMs:loop.max/1e6,maxPersonalViewBytes:Math.max(...viewBytes),inputTraffic:{seats:6,packetsPerSeat:inputSeq,packetsPerSeatPerSecond:inputSeq*1000/measuredMs,lastObservedAcceptedSeq:last.map(snapshot=>snapshot.lastAcceptedSeq)},ownerMetrics,tickAdvancement,admission:{maxActiveRooms:6,overflowRejected:true},crashRecovery:{recovered:true,receiptExactlyOnce:true,newEpoch:true,resumed:true},scope:'Actual built Node workers with live wall-clock physics, SQLite and IPC. This is automated server evidence; no browser or physical device.'};
  mkdirSync('.qa/test-bench',{recursive:true});writeFileSync('.qa/test-bench/worker-profile.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  assert.ok(inputSeq>250&&last.every(snapshot=>snapshot.lastAcceptedSeq>=inputSeq-3),'Six input streams must be accepted without an accumulating queue');
  assert.ok(report.parentEventLoopP95Ms<20,'Worker simulation should not block the parent event loop.');
  for(const metric of ownerMetrics){assert.ok(metric.pump.samples>300,'Profile must include at least300 actual owner ticks');assert.ok(metric.pump.p95Ms<12.525,`Owner ${metric.owner} whole-pump p95 ${metric.pump.p95Ms}ms exceeds75% of16.7ms`);assert.equal(metric.overloadPauseMs,0,'Overload must not pause game time');assert.ok(metric.checkpoint.samples>0&&metric.sqlite.samples>0,'Measure actual durable checkpoint pauses');}
  assert.ok(tickAdvancement.every(row=>row.phase==='racing'&&row.lagTicks<=6),'Every room must advance at60Hz without a growing backlog');
}finally{loop.disable();clearInterval(inputTimer);await inputTask;await Promise.allSettled(owners.map(w=>w.close()));rmSync(directory,{recursive:true,force:true});}
