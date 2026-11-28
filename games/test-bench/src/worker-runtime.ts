import { Worker } from 'node:worker_threads';
import { SessionError } from '@iva-games/session-kit';
import type { ActionEnvelope,GameRuntime,StartMatchRequest } from '@iva-games/session-kit';
import { WIRE_VERSION } from './types';
import type { BenchView } from './types';

const POOL_SIZE=2;
type Method='createMatch'|'viewForPlayer'|'applyAction'|'status'|'liveConnect'|'liveInput'|'liveSnapshot'|'liveDisconnect'|'close';
interface Pending {timer:ReturnType<typeof setTimeout>;resolve:(value:unknown)=>void;reject:(error:Error)=>void}
interface Slot {worker:Worker;alive:boolean;pending:Map<number,Pending>;ready:Promise<void>;resolveReady:()=>void;rejectReady:(error:Error)=>void;restarts:number;restartWindow:number}
interface LiveSnapshot {tick:number;serverTime:number;lastAcceptedSeq:number;view:BenchView}
const unavailable=()=>new SessionError('UNAVAILABLE','Игра восстанавливается. Повторите вход.',503);
function roomShard(roomId:string):number{let hash=2166136261;for(const char of roomId){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0)%POOL_SIZE;}
function matchShard(matchId:string):number{const found=/^tb(\d+)_/.exec(matchId);const shard=found?Number(found[1]):0;if(shard>=POOL_SIZE)throw new SessionError('INCOMPATIBLE_VERSION','Не удалось открыть эту партию.',409);return shard;}

/** Two bounded simulation owners keep Rapier stepping/checkpoint writes off the platform event loop. */
export class WorkerTestBenchRuntime implements GameRuntime {
  readonly wireVersion=WIRE_VERSION;
  readonly ready:Promise<void>;
  private readonly slots:Slot[]=[];
  private sequence=0;
  private closing=false;
  constructor(private readonly options:{databasePath:string;workerUrl:URL}){for(let index=0;index<POOL_SIZE;index++)this.slots[index]=this.spawn(index,0,Date.now());this.ready=Promise.all(this.slots.map(slot=>slot.ready)).then(()=>undefined);void this.ready.catch(()=>undefined);}
  private spawn(index:number,restarts:number,restartWindow:number):Slot{
    let resolveReady!:()=>void,rejectReady!:(error:Error)=>void;
    const ready=new Promise<void>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    // Keep startup failures attached even before the first room sends a request.
    void ready.catch(()=>undefined);
    const worker=new Worker(this.options.workerUrl,{workerData:{databasePath:this.options.databasePath,shard:{index,count:POOL_SIZE}},name:`iva-test-bench-${index}`});
    const slot:Slot={worker,alive:true,pending:new Map(),ready,resolveReady,rejectReady,restarts,restartWindow};
    const startupTimer=setTimeout(()=>{slot.rejectReady(unavailable());void worker.terminate();},10000);startupTimer.unref();
    worker.on('message',(message:{ready?:boolean;id?:number;value?:unknown;error?:{code?:string;message?:string;statusCode?:number}})=>{
      if(message.ready){clearTimeout(startupTimer);slot.resolveReady();return;}
      if(message.id===undefined)return;const pending=slot.pending.get(message.id);if(!pending)return;slot.pending.delete(message.id);clearTimeout(pending.timer);
      if(message.error)pending.reject(new SessionError(message.error.code??'UNAVAILABLE',message.error.message??'Игра восстанавливается.',message.error.statusCode??503));else pending.resolve(message.value);
    });
    worker.on('error',()=>{clearTimeout(startupTimer);slot.alive=false;slot.rejectReady(unavailable());for(const pending of slot.pending.values()){clearTimeout(pending.timer);pending.reject(unavailable());}slot.pending.clear();});
    worker.on('exit',()=>{
      clearTimeout(startupTimer);slot.alive=false;slot.rejectReady(unavailable());for(const pending of slot.pending.values()){clearTimeout(pending.timer);pending.reject(unavailable());}slot.pending.clear();
      if(this.closing||this.slots[index]!==slot)return;
      const window=Date.now()-slot.restartWindow>60000?Date.now():slot.restartWindow;const attempts=window!==slot.restartWindow?0:slot.restarts;
      if(attempts<3)this.slots[index]=this.spawn(index,attempts+1,window);
    });
    return slot;
  }
  private async call<T>(index:number,method:Method,args:unknown[]):Promise<T>{
    if(this.closing&&method!=='close')throw unavailable();
    const slot=this.slots[index];await slot.ready;
    if(!slot.alive||slot!==this.slots[index]||slot.pending.size>=256)throw unavailable();
    const id=++this.sequence;
    return new Promise<T>((resolve,reject)=>{const timer=setTimeout(()=>{slot.pending.delete(id);reject(unavailable());void slot.worker.terminate();},10000);timer.unref();slot.pending.set(id,{timer,resolve:value=>resolve(value as T),reject});try{slot.worker.postMessage({id,method,args});}catch{clearTimeout(timer);slot.pending.delete(id);reject(unavailable());}});
  }
  async createMatch(request:StartMatchRequest):Promise<{matchId:string}>{const first=roomShard(request.roomId);try{return await this.call(first,'createMatch',[request]);}catch(error){if(error instanceof SessionError&&error.code==='GAME_BUSY')return this.call((first+1)%POOL_SIZE,'createMatch',[request]);throw error;}}
  viewForPlayer(matchId:string,playerId:string):Promise<BenchView>{return this.call(matchShard(matchId),'viewForPlayer',[matchId,playerId]);}
  applyAction(matchId:string,playerId:string,command:ActionEnvelope):Promise<BenchView>{return this.call(matchShard(matchId),'applyAction',[matchId,playerId,command]);}
  status(matchId:string):Promise<{finished:boolean;outcome?:unknown}>{return this.call(matchShard(matchId),'status',[matchId]);}
  liveConnect(matchId:string,playerId:string,epoch:string):Promise<LiveSnapshot>{return this.call(matchShard(matchId),'liveConnect',[matchId,playerId,epoch]);}
  liveInput(matchId:string,playerId:string,input:{epoch:string;seq:number;payload:unknown}):Promise<void>{return this.call(matchShard(matchId),'liveInput',[matchId,playerId,input]);}
  liveSnapshot(matchId:string,playerId:string,epoch:string):Promise<LiveSnapshot>{return this.call(matchShard(matchId),'liveSnapshot',[matchId,playerId,epoch]);}
  liveDisconnect(matchId:string,playerId:string,epoch:string):Promise<void>{return this.call(matchShard(matchId),'liveDisconnect',[matchId,playerId,epoch]);}
  async close():Promise<void>{if(this.closing)return;this.closing=true;const results=await Promise.allSettled(this.slots.map(async(slot,index)=>{try{await this.call(index,'close',[]);}finally{await slot.worker.terminate();}}));const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;}
}
