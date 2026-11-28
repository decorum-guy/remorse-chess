import { useCallback, useEffect, useRef, useState } from 'react';
import type { BenchAction, BenchView, DriveInput } from './types';
import { WIRE_VERSION } from './types';
export type Request = <T>(path:string,body?:unknown)=>Promise<T>;
export type ConnectionState='connecting'|'online'|'reconnecting'|'superseded';
interface Scope {protocol:string;wireVersion:string;roomId:string;matchId:string;epoch:string}
export function useBenchLive(roomId:string,matchId:string,request:Request) {
  const [view,setView]=useState<BenchView|null>(null);
  const latest=useRef<BenchView|null>(null);
  const [connection,setConnection]=useState<ConnectionState>('connecting');
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState<{actionId:string;expectedRevision:number;payload:BenchAction}|null>(null);
  const input=useRef<DriveInput>({throttle:0,steering:0,brake:true});
  const watch=useRef<string|null>(null);
  const scope=useRef<Scope|null>(null); const socket=useRef<WebSocket|null>(null);
  const active=useRef(true); const sending=useRef(false); const offset=useRef(0);
  const accept=useCallback((next:BenchView)=>{
    if(!active.current||next.matchId!==matchId)return;
    if(latest.current&&(next.revision<latest.current.revision||(next.revision===latest.current.revision&&next.tick<latest.current.tick)))return;
    latest.current=next;offset.current=next.serverTime-Date.now();setView(next);
  },[matchId]);
  const load=useCallback(async()=>{try{accept((await request<{view:BenchView}>('/rooms/'+roomId+'/match')).view);}catch{if(active.current)setError('NETWORK');}},[request,roomId,accept]);
  useEffect(()=>{
    active.current=true; let disposed=false; let seq=0;let reconnect:ReturnType<typeof setTimeout>|undefined;let attempt=0;let stopped=false;
    const connect=()=>{
      if(disposed||stopped)return;
      const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/platform/v1/rooms/'+encodeURIComponent(roomId)+'/live');socket.current=ws;
      ws.onmessage=event=>{
        if(disposed||socket.current!==ws)return;
        try{
          const frame=JSON.parse(String(event.data));
          if(frame.type==='error'){
            if(frame.code==='CONTROL_SUPERSEDED'){stopped=true;setConnection('superseded');}
            else if(frame.code==='STALE_CONTROL'||frame.code==='GAME_TIMEOUT'){scope.current=null;setConnection('reconnecting');ws.close();}
            else setError(frame.code||'NETWORK'); return;
          }
          if(frame.type!=='snapshot'||frame.roomId!==roomId||frame.matchId!==matchId||frame.wireVersion!==WIRE_VERSION)return;
          scope.current={protocol:'iva-live@1',wireVersion:frame.wireVersion,roomId,matchId,epoch:frame.epoch};
          if(frame.view){accept(frame.view);setConnection('online');setError(null);attempt=0;seq=Math.max(seq,frame.lastAcceptedSeq||0);}
        }catch{setError('INVALID_RESPONSE');}
      };
      ws.onclose=event=>{scope.current=null;if(disposed)return;if(event.code===4001||stopped){stopped=true;setConnection('superseded');return;}setConnection('reconnecting');reconnect=setTimeout(connect,Math.min(8000,500*2**attempt++));};
      ws.onerror=()=>{if(!disposed)setConnection('reconnecting');};
    };
    void load();connect();
    const timer=setInterval(()=>{
      if(socket.current?.readyState===WebSocket.OPEN&&scope.current&&latest.current?.phase==='racing'&&socket.current.bufferedAmount<16000){
        socket.current.send(JSON.stringify({...scope.current,type:'input',seq:++seq,payload:{...input.current,phaseId:latest.current.phaseId,watchParticipantId:watch.current}}));
      }
    },1000/30);
    const poll=setInterval(()=>{if(!scope.current&&!stopped)void load();},4000);
    return()=>{disposed=true;active.current=false;clearInterval(timer);clearInterval(poll);clearTimeout(reconnect);socket.current?.close();scope.current=null;};
  },[roomId,matchId,accept,load]);
  const submit=async(command:NonNullable<typeof pending>)=>{
    if(sending.current)return false;sending.current=true;setBusy(true);setError(null);
    try{const response=await request<{view:BenchView}>('/rooms/'+roomId+'/actions',command);accept(response.view);setPending(null);return true;}
    catch(cause){const failure=cause as {code?:string;status?:number};setError(failure.code||'NETWORK');if(failure.status&&failure.status<500){setPending(null);void load();}else setPending(command);return false;}
    finally{sending.current=false;setBusy(false);}
  };
  const act=async(action:BenchAction)=>{
    if(!latest.current||pending||connection==='superseded')return false;
    return submit({actionId:crypto.randomUUID(),expectedRevision:latest.current.revision,payload:action});
  };
  return {view,latest,connection,error,setError,busy,pending,act,retry:()=>pending?submit(pending):load(),input,offset,watch};
}
