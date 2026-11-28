import { PRESETS, validateBlueprint } from './catalog';
import { BOT_VERSION, CONTENT_VERSION, PHYSICS_VERSION, RULES_VERSION, WIRE_VERSION, BenchError } from './types';
import type { BenchAction, BenchState, CupStanding, LaneResult, StageRecord } from './types';
import type { Participant } from '@iva-games/session-kit';

export const PHASE_SECONDS={briefing:12,building:90,refit:65,countdown:4,racing:65,debrief:12,recovering:5} as const;
export function rankStage(results:LaneResult[]):LaneResult[]{
  const sorted=results.map(r=>({...r})).sort((a,b)=>b.delivered-a.delivered||b.integrity-a.integrity||a.elapsedTicks-b.elapsedTicks);
  for(let i=0;i<sorted.length;i++){const row=sorted[i],previous=sorted[i-1];row.place=previous&&row.delivered===previous.delivered&&row.integrity===previous.integrity&&row.elapsedTicks===previous.elapsedTicks?previous.place:i+1;row.points=row.finished&&row.delivered>0?sorted.length-row.place!+1:0;}
  return sorted;
}
export function rankCup(participants:Pick<Participant,'participantId'>[],stages:StageRecord[]):CupStanding[]{
  const sorted=participants.map(p=>{const results=stages.flatMap(stage=>stage.results.filter(r=>r.participantId===p.participantId));return {participantId:p.participantId,points:results.reduce((s,r)=>s+(r.points??0),0),delivered:results.reduce((s,r)=>s+r.delivered,0),integrity:results.reduce((s,r)=>s+r.integrity,0),elapsedTicks:results.reduce((s,r)=>s+r.elapsedTicks,0),place:0};}).sort((a,b)=>b.points-a.points||b.delivered-a.delivered||b.integrity-a.integrity||a.elapsedTicks-b.elapsedTicks);
  for(let i=0;i<sorted.length;i++){const row=sorted[i],prev=sorted[i-1];row.place=prev&&row.points===prev.points&&row.delivered===prev.delivered&&row.integrity===prev.integrity&&row.elapsedTicks===prev.elapsedTicks?prev.place:i+1;}
  return sorted;
}
export function createBenchState(input:{matchId:string;roomId:string;participants:Participant[];seed:number;now:number}):BenchState{
  let seed=input.seed>>>0;const variants=[0,1,2].map(()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)%2===1;});
  return {schemaVersion:1,matchId:input.matchId,roomId:input.roomId,rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,wireVersion:WIRE_VERSION,botVersion:BOT_VERSION,physicsVersion:PHYSICS_VERSION,seed:input.seed,participants:structuredClone(input.participants),phase:'briefing',phaseId:1,phaseEndsAt:input.now+PHASE_SECONDS.briefing*1000,stage:0,tick:0,revision:0,variants,builds:Object.fromEntries(input.participants.map(p=>[p.participantId,{blueprint:structuredClone(PRESETS.universal),previous:null,revision:0,ready:false}])),confirmations:[],stages:[],standings:[],lanes:{},savedAt:input.now};
}
export function parseBenchAction(input:unknown):BenchAction{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new BenchError('INVALID_ACTION');
  const value=input as Record<string,unknown>;
  if(!Number.isSafeInteger(value.phaseId)||Number(value.phaseId)<1)throw new BenchError('INVALID_ACTION');
  const phaseId=Number(value.phaseId);
  if(value.type==='confirm'||value.type==='interact'||value.type==='restore')return {type:value.type,phaseId};
  if(value.type==='ready'&&typeof value.ready==='boolean')return {type:'ready',phaseId,ready:value.ready};
  if(value.type==='blueprint'&&Number.isSafeInteger(value.buildRevision)&&Number(value.buildRevision)>=0)return {type:'blueprint',phaseId,blueprint:validateBlueprint(value.blueprint),buildRevision:Number(value.buildRevision)};
  throw new BenchError('INVALID_ACTION');
}
