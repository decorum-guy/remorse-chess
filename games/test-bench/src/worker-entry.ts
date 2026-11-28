import { parentPort,workerData } from 'node:worker_threads';
import { SessionError } from '@iva-games/session-kit';
import { TestBenchRuntime } from './runtime';

if(!parentPort)throw new Error('Test Bench simulation worker requires a parent port');
const runtime=new TestBenchRuntime(workerData as {databasePath:string;shard:{index:number;count:number}});
const methods=['createMatch','viewForPlayer','applyAction','status','liveConnect','liveInput','liveSnapshot','liveDisconnect','ownerMetrics','close'] as const;
type Method=typeof methods[number];
parentPort.on('message',async(message:{id:number;method:Method;args:unknown[]})=>{
  if(!Number.isSafeInteger(message.id)||!methods.includes(message.method)||!Array.isArray(message.args))return;
  try{
    const fn=runtime[message.method] as (...args:unknown[])=>Promise<unknown>;
    const value=await fn.apply(runtime,message.args);parentPort!.postMessage({id:message.id,value});
  }catch(error){parentPort!.postMessage({id:message.id,error:error instanceof SessionError?{code:error.code,message:error.message,statusCode:error.statusCode}:{code:'UNAVAILABLE',message:'Игра восстанавливается. Повторите вход.',statusCode:503}});}
});
await runtime.ready;
parentPort.postMessage({ready:true});
