import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { canonicalJson,SessionError } from '@iva-games/session-kit';
import type { ActionEnvelope,GameRegistration,GameRuntime,Participant,StartMatchRequest } from '@iva-games/session-kit';
import { blueprintCost,blueprintEdits,validateBlueprint } from './catalog';
import { chooseBotBlueprint,chooseBotInput } from './bots';
import { LanePhysics,NEUTRAL_INPUT,initPhysics,sanitizeInput } from './physics';
import { createBenchState,parseBenchAction,PHASE_SECONDS,rankCup,rankStage } from './rules';
import { BenchStore } from './store';
import { WorkerTestBenchRuntime } from './worker-runtime';
import { getTrack,TRACK_ORDER } from './tracks';
import { BOT_VERSION,CONTENT_VERSION,PHYSICS_VERSION,RULES_VERSION,WIRE_VERSION,BenchError,STEP } from './types';
import type { BenchAction,BenchState,BenchView,DriveInput,Phase } from './types';

interface Control { epoch:string;seq:number;lastInputAt:number;input:DriveInput;watchParticipantId:string|null }
interface LiveMatch { state:BenchState;lanes:Map<string,LanePhysics>;lastStepAt:number;lastSavedTick:number;quarantined?:boolean }
interface LiveSnapshot { tick:number;serverTime:number;lastAcceptedSeq:number;view:BenchView }
interface LiveInput { epoch:string;seq:number;payload:unknown }
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(value);
const knownErrors:Record<string,string>={INVALID_BLUEPRINT:'Проверьте конструкцию машины.',INVALID_PART:'Выберите подходящую деталь.',DUPLICATE_MODULE:'Эту деталь можно установить только один раз.',OVER_BUDGET:'Не хватает жетонов.',TOO_MANY_EDITS:'Можно изменить только два крепления.',INVALID_ACTION:'Повторите действие.',WRONG_PHASE:'Этот этап уже закончился.',BUILD_LOCKED:'Снимите готовность, чтобы изменить машину.',STALE_BUILD:'Конструкция обновилась. Выберите деталь ещё раз.',UNAVAILABLE_ACTION:'Подъедьте к грузу и остановитесь.'};
const sessionError=(error:unknown):never=>{if(error instanceof BenchError)throw new SessionError(error.code,knownErrors[error.code]??'Повторите действие.',error.code==='WRONG_PHASE'||error.code==='STALE_BUILD'?409:400);throw error;};
function settings(input:unknown):Record<string,unknown>{
  if(input!==undefined&&(input===null||typeof input!=='object'||Array.isArray(input)))throw new SessionError('INVALID_SETTINGS','Проверьте настройки комнаты.');
  return {cup:'standard'};
}
function roster(input:StartMatchRequest):void{
  if(!identifier(input?.startCommandId)||!identifier(input?.roomId)||input.rulesVersion!==RULES_VERSION||input.contentVersion!==CONTENT_VERSION)throw new SessionError('INCOMPATIBLE_VERSION','Создайте новую комнату.',409);
  if(!Array.isArray(input.participants)||input.participants.length<2||input.participants.length>6)throw new SessionError('INVALID_ROSTER','Нужно от двух до шести участников.');
  const ids=new Set<string>(),seats=new Set<number>(),humans=new Set<string>();
  for(const p of input.participants){
    if(!p||!identifier(p.participantId)||ids.has(p.participantId)||!Number.isInteger(p.seatIndex)||p.seatIndex<0||p.seatIndex>5||seats.has(p.seatIndex)||typeof p.displayName!=='string'||!p.displayName.trim()||p.displayName.length>40)throw new SessionError('INVALID_ROSTER','Проверьте участников комнаты.');
    ids.add(p.participantId);seats.add(p.seatIndex);
    if(p.controller?.kind==='human'){if(!identifier(p.playerId)||p.playerId!==p.controller.playerId||humans.has(p.playerId))throw new SessionError('INVALID_ROSTER','У игрока должно быть одно место.');humans.add(p.playerId);}
    else if(p.controller?.kind==='bot'){if(p.playerId!==null||!['easy','normal','hard'].includes(p.controller.difficulty)||p.controller.botVersion!==BOT_VERSION||p.controller.botProfileId!==`test-bench:${p.controller.difficulty}`)throw new SessionError('INVALID_ROSTER','Добавьте бота заново.');}
    else throw new SessionError('INVALID_ROSTER','Проверьте участников комнаты.');
  }
  if(!humans.size)throw new SessionError('INVALID_ROSTER','В комнате нужен хотя бы один игрок.');
  settings(input.settings);
}

export class TestBenchRuntime implements GameRuntime {
  readonly wireVersion=WIRE_VERSION;
  private readonly store:BenchStore;
  private readonly now:()=>number;
  private readonly shard:{index:number;count:number}|undefined;
  private readonly matches=new Map<string,LiveMatch>();
  private readonly controls=new Map<string,Control>();
  readonly ready:Promise<void>;
  private timer:ReturnType<typeof setInterval>|undefined;
  private closed=false;
  private failure:unknown;
  private profile={startedAt:performance.now(),pumpMs:[] as number[],checkpointMs:[] as number[],sqliteMs:[] as number[],simulationSteps:0,physicsSteps:0,overloadPauseMs:0};
  private sample(values:number[],elapsed:number):void{if(values.length>=4096)values.shift();values.push(elapsed);}
  /** Internal worker diagnostics; this method is not exposed by the portal or live gateway. */
  async ownerMetrics(reset=false){
    await this.ready;
    const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {samples:values.length,p95Ms:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))]??0,p99Ms:sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.99))]??0,maxMs:sorted.at(-1)??0};};
    const result={owner:this.shard?.index??0,activeMatches:[...this.matches.values()].filter(entry=>entry.state.phase!=='finished').length,windowMs:performance.now()-this.profile.startedAt,pump:stats(this.profile.pumpMs),checkpoint:stats(this.profile.checkpointMs),sqlite:stats(this.profile.sqliteMs),simulationSteps:this.profile.simulationSteps,physicsSteps:this.profile.physicsSteps,overloadPauseMs:this.profile.overloadPauseMs};
    if(reset)this.profile={startedAt:performance.now(),pumpMs:[],checkpointMs:[],sqliteMs:[],simulationSteps:0,physicsSteps:0,overloadPauseMs:0};
    return result;
  }
  private timedWrite(write:()=>void):void{const started=performance.now();try{write();}finally{this.sample(this.profile.sqliteMs,performance.now()-started);}}

  constructor(options:{databasePath:string;now?:()=>number;autoTick?:boolean;shard?:{index:number;count:number}}){
    this.shard=options.shard;
    this.now=options.now??Date.now;this.store=new BenchStore(options.databasePath);
    this.ready=initPhysics().then(()=>{
      for(const row of this.store.all()){
        const state=JSON.parse(row.state) as BenchState;
        if(options.shard&&(Number(/^tb(\d+)_/.exec(state.matchId)?.[1]??0)!==options.shard.index))continue;
        if(state.schemaVersion!==1||state.rulesVersion!==RULES_VERSION||state.contentVersion!==CONTENT_VERSION||state.physicsVersion!==PHYSICS_VERSION)throw new Error('Unsupported saved Test Bench match');
        if(state.phase==='finished')continue;
        const lanes=new Map<string,LanePhysics>();for(const [id,snapshot] of Object.entries(state.lanes))lanes.set(id,new LanePhysics({blueprint:snapshot.blueprint,track:getTrack(snapshot.trackId,snapshot.mirrored),participantId:id,snapshot}));
        if(state.phase!=='recovering')state.recovery={phase:state.phase,remainingMs:Math.max(0,state.phaseEndsAt-state.savedAt)};
        state.phase='recovering';state.phaseId++;state.phaseEndsAt=this.now()+5000;state.savedAt=this.now();state.revision++;
        const entry={state,lanes,lastStepAt:this.now(),lastSavedTick:state.tick};this.matches.set(state.matchId,entry);this.persist(entry);
      }
      if(options.autoTick!==false){this.timer=setInterval(()=>{try{this.pump(this.now());}catch(error){this.failure=error;if(this.timer)clearInterval(this.timer);}},1000/60);this.timer.unref?.();}
    });
  }
  registration():GameRegistration{return {gameId:'test-bench',collectionId:'other',title:'Испытательный стенд',minPlayers:2,maxPlayers:6,supportsBots:true,rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,status:'available',runtime:this,normalizeSettings:settings,resolveRoomVersion:(rulesVersion,contentVersion)=>rulesVersion===RULES_VERSION&&contentVersion===CONTENT_VERSION?{normalizeSettings:settings,botVersion:BOT_VERSION}:undefined};}
  private controlKey(matchId:string,playerId:string){return `${matchId}:${playerId}`;}
  private human(state:BenchState,playerId:string):Participant{const p=state.participants.find(p=>p.controller.kind==='human'&&p.playerId===playerId);if(!p)throw new SessionError('FORBIDDEN','Вы не участник этой партии.',403);return p;}
  private entry(matchId:string):LiveMatch{
    if(this.closed)throw new SessionError('UNAVAILABLE','Игра перезапускается.',503);
    if(this.failure)throw new SessionError('UNAVAILABLE','Игра восстанавливается. Повторите вход.',503);
    const current=this.matches.get(matchId);if(current){if(current.quarantined)this.recoverQuarantined(current);return current;}
    const row=this.store.read(matchId);if(!row)throw new SessionError('MATCH_NOT_FOUND','Партия не найдена.',404);
    const state=JSON.parse(row.state) as BenchState;const entry={state,lanes:new Map<string,LanePhysics>(),lastStepAt:this.now(),lastSavedTick:state.tick};this.matches.set(matchId,entry);this.pruneFinished();return entry;
  }
  private pruneFinished():void {
    const completed=[...this.matches].filter(([,entry])=>entry.state.phase==='finished');
    for(const [id,entry] of completed.slice(0,Math.max(0,completed.length-64))){
      this.matches.delete(id);
      for(const participant of entry.state.participants)if(participant.playerId)this.controls.delete(this.controlKey(id,participant.playerId));
    }
  }
  private capture(entry:LiveMatch):void{entry.state.lanes=Object.fromEntries([...entry.lanes].map(([id,lane])=>[id,lane.checkpoint()]));entry.state.savedAt=this.now();entry.lastSavedTick=entry.state.tick;}
  private persist(entry:LiveMatch):void{
    const started=performance.now();
    try{this.capture(entry);this.timedWrite(()=>this.store.save(entry.state));}
    catch{this.quarantine(entry);throw new SessionError('UNAVAILABLE','Игра восстанавливается. Повторите вход.',503);}
    finally{this.sample(this.profile.checkpointMs,performance.now()-started);}
  }
  private quarantine(entry:LiveMatch):void {
    entry.quarantined=true;
    for(const p of entry.state.participants)if(p.playerId)this.controls.delete(this.controlKey(entry.state.matchId,p.playerId));
    for(const lane of entry.lanes.values())lane.dispose();entry.lanes.clear();
    try{const row=this.store.read(entry.state.matchId);if(row)entry.state=JSON.parse(row.state) as BenchState;}catch{/* No view is served until the durable state is readable again. */}
  }
  private recoverQuarantined(entry:LiveMatch):void {
    const lanes=new Map<string,LanePhysics>();
    try{
      const row=this.store.read(entry.state.matchId);if(!row)throw new Error('Missing recovery checkpoint');
      const state=JSON.parse(row.state) as BenchState;
      for(const [id,snapshot] of Object.entries(state.lanes))lanes.set(id,new LanePhysics({blueprint:snapshot.blueprint,track:getTrack(snapshot.trackId,snapshot.mirrored),participantId:id,snapshot}));
      if(state.phase!=='finished'){
        if(state.phase!=='recovering')state.recovery={phase:state.phase,remainingMs:Math.max(0,state.phaseEndsAt-state.savedAt)};
        state.phase='recovering';state.phaseId++;state.phaseEndsAt=this.now()+5000;state.savedAt=this.now();state.revision++;
      }
      this.store.save(state);
      entry.state=state;entry.lanes=lanes;entry.lastStepAt=this.now();entry.lastSavedTick=state.tick;entry.quarantined=false;
    }catch{for(const lane of lanes.values())lane.dispose();throw new SessionError('UNAVAILABLE','Игра восстанавливается. Повторите вход.',503);}
  }
  private phase(entry:LiveMatch,next:Phase,now:number):void{
    const state=entry.state;state.phase=next;state.phaseId++;state.revision++;state.confirmations=[];
    const seconds=next==='building'?(state.stage===0?PHASE_SECONDS.building:PHASE_SECONDS.refit):next==='finished'?0:PHASE_SECONDS[next];state.phaseEndsAt=now+seconds*1000;
    if(next==='building'){
      for(const lane of entry.lanes.values())lane.dispose();entry.lanes.clear();state.lanes={};
      for(const participant of state.participants){const build=state.builds[participant.participantId];build.ready=false;if(state.stage>0)build.previous=structuredClone(build.blueprint);if(participant.controller.kind==='bot'){build.blueprint=chooseBotBlueprint(build.previous,state.stage,participant.controller.difficulty);build.ready=true;build.revision++;}}
    }
    if(next==='countdown'){
      for(const p of state.participants){const build=state.builds[p.participantId];build.blueprint=validateBlueprint(build.blueprint,build.previous);build.ready=true;entry.lanes.set(p.participantId,new LanePhysics({blueprint:build.blueprint,track:getTrack(TRACK_ORDER[state.stage],state.variants[state.stage]),participantId:p.participantId}));}
    }
    if(next==='racing')for(const p of state.participants)if(p.playerId){const control=this.controls.get(this.controlKey(state.matchId,p.playerId));if(control){control.input={...NEUTRAL_INPUT};control.lastInputAt=0;control.watchParticipantId=null;}}
    if(next==='debrief'){
      const results=rankStage([...entry.lanes].map(([id,lane])=>lane.snapshot().result??{participantId:id,delivered:0,integrity:0,elapsedTicks:3900+lane.snapshot().resets*300,resets:lane.snapshot().resets,finished:false}));
      state.stages.push({stage:state.stage,trackId:TRACK_ORDER[state.stage],mirrored:state.variants[state.stage],results,blueprints:Object.fromEntries(Object.entries(state.builds).map(([id,b])=>[id,structuredClone(b.blueprint)])),events:Object.fromEntries([...entry.lanes].map(([id,lane])=>[id,lane.snapshot().events]))});state.standings=rankCup(state.participants,state.stages);
    }
    if(next==='finished'){for(const lane of entry.lanes.values())lane.dispose();entry.lanes.clear();state.lanes={};this.pruneFinished();}
    this.persist(entry);
  }
  private advancePhase(entry:LiveMatch,now:number):void{
    const s=entry.state;const humans=s.participants.filter(p=>p.controller.kind==='human');
    if(s.phase==='recovering'&&now>=s.phaseEndsAt){const recovery=s.recovery!;s.phase=recovery.phase;s.phaseId++;s.phaseEndsAt=now+recovery.remainingMs;s.revision++;delete s.recovery;this.persist(entry);return;}
    if(s.phase==='briefing'&&(now>=s.phaseEndsAt||humans.every(p=>s.confirmations.includes(p.participantId))))this.phase(entry,'building',now);
    else if(s.phase==='building'&&(now>=s.phaseEndsAt||s.participants.every(p=>s.builds[p.participantId].ready)))this.phase(entry,'countdown',now);
    else if(s.phase==='countdown'&&now>=s.phaseEndsAt)this.phase(entry,'racing',now);
    else if(s.phase==='racing'&&[...entry.lanes.values()].every(lane=>lane.observe().finished))this.phase(entry,'debrief',now);
    else if(s.phase==='debrief'&&(now>=s.phaseEndsAt||humans.every(p=>s.confirmations.includes(p.participantId)))){if(s.stage===2)this.phase(entry,'finished',now);else{s.stage++;this.phase(entry,'briefing',now);}}
  }
  private step(entry:LiveMatch,now:number):void{
    this.advancePhase(entry,now);const state=entry.state;if(state.phase==='finished'||state.phase==='recovering')return;
    state.tick++;this.profile.simulationSteps++;
    if(state.phase==='racing'){
      let significant=false;
      for(const participant of state.participants){const lane=entry.lanes.get(participant.participantId)!;const previous=lane.observe();if(previous.finished)continue;const previousEventId=previous.events.at(-1)?.id;let input:DriveInput;
        if(participant.controller.kind==='bot'){
          const action=chooseBotInput(previous,lane.track,participant.controller.difficulty);if(action.interact)lane.interact();if(action.restore)lane.restore();input=action.input;
        }else{const control=this.controls.get(this.controlKey(state.matchId,participant.playerId!));input=control&&now-control.lastInputAt<=300?control.input:NEUTRAL_INPUT;}
        lane.advance(input);this.profile.physicsSteps++;if(lane.observe().events.at(-1)?.id!==previousEventId)significant=true;
      }
      if(significant)this.persist(entry);
      this.advancePhase(entry,now);
    }
    if(state.tick-entry.lastSavedTick>=120)this.persist(entry);
  }
  private pump(now:number):void {
    const started=performance.now();const stepsBefore=this.profile.simulationSteps;
    for(const entry of this.matches.values()){
      if(entry.state.phase==='finished'||entry.quarantined)continue;
      try{
      let count=0;
      while(now-entry.lastStepAt>=STEP*1000&&count<12){entry.lastStepAt+=STEP*1000;this.step(entry,entry.lastStepAt);count++;}
      // An overloaded owner pauses the match instead of silently consuming racing time.
      if(now-entry.lastStepAt>250){const skipped=now-entry.lastStepAt;this.profile.overloadPauseMs+=skipped;entry.state.phaseEndsAt+=skipped;entry.lastStepAt=now;this.persist(entry);}
      }catch{this.quarantine(entry);}
    }
    if(this.profile.simulationSteps>stepsBefore)this.sample(this.profile.pumpMs,performance.now()-started);
  }
  /** Deterministic headless driver used by load/recovery tests; never exposed by HTTP. */
  async advanceSimulation(steps:number):Promise<void>{await this.ready;for(let i=0;i<steps;i++)for(const entry of this.matches.values()){if(entry.quarantined)continue;entry.lastStepAt+=STEP*1000;this.step(entry,entry.lastStepAt);}}
  async createMatch(input:StartMatchRequest):Promise<{matchId:string}>{
    await this.ready;roster(input);const hash=digest(input);const prior=this.store.byStartOrRoom(input.startCommandId,input.roomId);
    if(prior){if(prior.request_hash!==hash)throw new SessionError('START_CONFLICT','Партия уже началась.',409);return {matchId:prior.match_id};}
    if(this.shard&&[...this.matches.values()].filter(entry=>entry.state.phase!=='finished').length>=3)throw new SessionError('GAME_BUSY','Стенд занят. Попробуйте немного позже.',503);
    const matchId=this.shard?`tb${this.shard.index}_${randomUUID()}`:randomUUID();const state=createBenchState({matchId,roomId:input.roomId,participants:input.participants,seed:randomBytes(4).readUInt32LE(),now:this.now()});this.store.create(state,input.startCommandId,hash);this.matches.set(matchId,{state,lanes:new Map(),lastStepAt:this.now(),lastSavedTick:0});return {matchId};
  }
  private view(entry:LiveMatch,playerId:string):BenchView{
    const s=entry.state;const you=this.human(s,playerId);const build=s.builds[you.participantId];const spectatingId=entry.lanes.get(you.participantId)?.observe().finished?this.controls.get(this.controlKey(s.matchId,playerId))?.watchParticipantId??null:null;const resultPhase=s.phase==='debrief'||s.phase==='finished';const hidden=s.phase==='building'||s.phase==='briefing'||(s.phase==='recovering'&&(s.recovery?.phase==='building'||s.recovery?.phase==='briefing'));
    return {matchId:s.matchId,roomId:s.roomId,rulesVersion:s.rulesVersion,contentVersion:s.contentVersion,physicsVersion:s.physicsVersion,phase:s.phase,phaseId:s.phaseId,phaseEndsAt:s.phaseEndsAt,serverTime:this.now(),stage:s.stage,tick:s.tick,revision:s.revision,spectatingId,track:getTrack(TRACK_ORDER[s.stage],s.variants[s.stage]),tracks:TRACK_ORDER.map((id,i)=>getTrack(id,s.variants[i])),you:{participantId:you.participantId,build:structuredClone(build),budget:blueprintCost(build.blueprint),edits:blueprintEdits(build.blueprint,build.previous),lane:resultPhase?null:entry.lanes.get(you.participantId)?.snapshot()??null},players:s.participants.map(p=>({...structuredClone(p),ready:s.builds[p.participantId].ready,confirmed:s.confirmations.includes(p.participantId),blueprint:hidden&&p.participantId!==you.participantId?null:structuredClone(s.builds[p.participantId].blueprint),lane:!resultPhase&&p.participantId===spectatingId&&p.participantId!==you.participantId?entry.lanes.get(p.participantId)?.snapshot()??null:null,progress:entry.lanes.has(p.participantId)?(()=>{const lane=entry.lanes.get(p.participantId)!.observe();return {gatesPassed:lane.gatesPassed,finished:lane.finished,delivered:lane.result?.delivered??0,integrity:lane.result?.integrity??0};})():null})),stages:resultPhase?structuredClone(s.stages):[],standings:structuredClone(s.standings)};
  }
  async viewForPlayer(matchId:string,playerId:string):Promise<BenchView>{await this.ready;return this.view(this.entry(matchId),playerId);}
  private perform(entry:LiveMatch,participantId:string,action:BenchAction):void{
    const s=entry.state;if(action.phaseId!==s.phaseId)throw new BenchError('WRONG_PHASE');
    if(action.type==='confirm'){if(s.phase!=='briefing'&&s.phase!=='debrief')throw new BenchError('WRONG_PHASE');if(!s.confirmations.includes(participantId))s.confirmations.push(participantId);}
    else if(action.type==='blueprint'){if(s.phase!=='building')throw new BenchError('WRONG_PHASE');const build=s.builds[participantId];if(build.ready)throw new BenchError('BUILD_LOCKED');if(build.revision!==action.buildRevision)throw new BenchError('STALE_BUILD');build.blueprint=validateBlueprint(action.blueprint,build.previous);build.revision++;}
    else if(action.type==='ready'){if(s.phase!=='building')throw new BenchError('WRONG_PHASE');s.builds[participantId].ready=action.ready;}
    else {if(s.phase!=='racing')throw new BenchError('WRONG_PHASE');const lane=entry.lanes.get(participantId)!;if(action.type==='interact'){if(!lane.interact())throw new BenchError('UNAVAILABLE_ACTION');}else lane.restore();}
    s.revision++;
  }
  async applyAction(matchId:string,playerId:string,command:ActionEnvelope):Promise<BenchView>{
    await this.ready;const entry=this.entry(matchId);const participant=this.human(entry.state,playerId);
    if(!command||!identifier(command.actionId)||!Number.isSafeInteger(command.expectedRevision))throw new SessionError('INVALID_ACTION','Повторите действие.');
    // The portal envelope revision is a transport observation, not a global lock.
    // Concurrent seats are independent: phaseId guards the shared phase, while
    // buildRevision compares-and-swaps only the acting player's draft.
    const hash=digest(command);const receipt=this.store.receipt(matchId,participant.participantId,command.actionId);
    if(receipt){if(receipt.request_hash!==hash)throw new SessionError('ACTION_CONFLICT','Повторите действие с новым запросом.',409);return this.view(entry,playerId);}
    try{
      const action=parseBenchAction(command.payload);this.perform(entry,participant.participantId,action);
      let response:BenchView;const started=performance.now();try{this.capture(entry);response=this.view(entry,playerId);this.timedWrite(()=>this.store.saveWithReceipt(entry.state,participant.participantId,command.actionId,hash,{accepted:true,revision:entry.state.revision}));}catch{this.quarantine(entry);throw new SessionError('UNAVAILABLE','Игра восстанавливается. Повторите вход.',503);}finally{this.sample(this.profile.checkpointMs,performance.now()-started);}
      this.advancePhase(entry,this.now());return response.phaseId===entry.state.phaseId?response:this.view(entry,playerId);
    }catch(error){return sessionError(error);}
  }
  async status(matchId:string):Promise<{finished:boolean;outcome?:unknown}>{await this.ready;const state=this.entry(matchId).state;return {finished:state.phase==='finished',...(state.phase==='finished'?{outcome:{standings:structuredClone(state.standings),winners:state.standings.filter(s=>s.place===1).map(s=>s.participantId)}}:{})};}
  async liveConnect(matchId:string,playerId:string,epoch:string):Promise<LiveSnapshot>{await this.ready;const entry=this.entry(matchId);this.human(entry.state,playerId);this.controls.set(this.controlKey(matchId,playerId),{epoch,seq:-1,lastInputAt:0,input:{...NEUTRAL_INPUT},watchParticipantId:null});return this.liveSnapshot(matchId,playerId,epoch);}
  async liveInput(matchId:string,playerId:string,input:LiveInput):Promise<void>{await this.ready;const entry=this.entry(matchId);this.human(entry.state,playerId);const control=this.controls.get(this.controlKey(matchId,playerId));if(!control||control.epoch!==input.epoch)throw new SessionError('STALE_CONTROL','Подключение заменено.',409);if(!Number.isSafeInteger(input.seq)||input.seq<=control.seq)return;
    const payload=input.payload as Record<string,unknown>|null;if(!payload||payload.phaseId!==entry.state.phaseId||entry.state.phase!=='racing')return;control.seq=input.seq;control.input=sanitizeInput(payload);control.lastInputAt=this.now();const participant=this.human(entry.state,playerId);if(entry.lanes.get(participant.participantId)?.observe().finished){if(payload.watchParticipantId===null||payload.watchParticipantId===participant.participantId)control.watchParticipantId=null;else if(typeof payload.watchParticipantId==='string'&&entry.state.participants.some(p=>p.participantId===payload.watchParticipantId))control.watchParticipantId=payload.watchParticipantId;}
  }
  async liveSnapshot(matchId:string,playerId:string,epoch:string):Promise<LiveSnapshot>{await this.ready;const entry=this.entry(matchId);const control=this.controls.get(this.controlKey(matchId,playerId));if(!control||control.epoch!==epoch)throw new SessionError('STALE_CONTROL','Подключение заменено.',409);return {tick:entry.state.tick,serverTime:this.now(),lastAcceptedSeq:control.seq,view:this.view(entry,playerId)};}
  async liveDisconnect(matchId:string,playerId:string,epoch:string):Promise<void>{await this.ready;const key=this.controlKey(matchId,playerId),control=this.controls.get(key);if(control?.epoch===epoch){control.input={...NEUTRAL_INPUT};control.lastInputAt=0;}}
  async close():Promise<void>{if(this.closed)return;if(this.timer)clearInterval(this.timer);await this.ready;for(const entry of this.matches.values()){if(!entry.quarantined)this.persist(entry);for(const lane of entry.lanes.values())lane.dispose();}this.matches.clear();this.store.close();this.closed=true;}
}
export function createTestBenchRegistration(options:{databasePath:string;now?:()=>number;autoTick?:boolean;workerUrl?:URL}):GameRegistration&{ready:Promise<void>;close:()=>Promise<void>}{
  const runtime=options.workerUrl?new WorkerTestBenchRuntime({databasePath:options.databasePath,workerUrl:options.workerUrl}):new TestBenchRuntime(options);
  const registration:GameRegistration={gameId:'test-bench',collectionId:'other',title:'Испытательный стенд',minPlayers:2,maxPlayers:6,supportsBots:true,rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,status:'available',runtime,normalizeSettings:settings,resolveRoomVersion:(rulesVersion,contentVersion)=>rulesVersion===RULES_VERSION&&contentVersion===CONTENT_VERSION?{normalizeSettings:settings,botVersion:BOT_VERSION}:undefined};
  return {...registration,ready:runtime.ready,close:()=>runtime.close()};
}
