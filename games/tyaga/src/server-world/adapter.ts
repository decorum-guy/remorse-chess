import type { GameAdapter } from '@iva-games/realtime-kit';
import { REALTIME_PROTOCOL } from '@iva-games/realtime-kit';
import { BOT_VERSION, CONTENT_VERSION, NEUTRAL_INPUT, RULES_VERSION, normalizeInput, normalizeTyagaSettings } from '../core/config';
import { PHYSICS_BUILD_HASH, TyagaWorld } from './world';

export function createTyagaAdapter():GameAdapter<TyagaWorld>{
  return{
    gameId:'tyaga',rulesVersion:RULES_VERSION,contentVersion:CONTENT_VERSION,protocolVersion:REALTIME_PROTOCOL,
    physicsBuildHash:PHYSICS_BUILD_HASH,runtimeArtifactId:'tyaga-runtime@1',serializerVersion:'tyaga-world@1',botVersion:BOT_VERSION,tickRate:60,snapshotRate:20,immutableViewFields:['map'],
    async create(request){const settings=normalizeTyagaSettings(request.settings);return TyagaWorld.create({matchId:`tyaga:${request.roomId}:${request.startCommandId}`,mapId:settings.mapId,mode:settings.mode,participants:request.participants.map(p=>({participantId:p.participantId,displayName:p.displayName,seatIndex:p.seatIndex,bot:p.controller.kind==='bot',appearance:{head:settings.head as 0|1,backpack:settings.pack as 0|1},...(p.controller.kind==='bot'?{botProfile:p.controller.difficulty==='hard'?'driver' as const:'helper' as const}:{})}))});},
    restore:serialized=>TyagaWorld.restore(serialized),serialize:world=>world.serialize(),input:normalizeInput,neutralInput:()=>({...NEUTRAL_INPUT}),
    step(world,inputs,context){world.step(inputs,context);},action:(world,pid,payload)=>world.action(pid,payload),view:(world,pid)=>world.view(pid),outcome:world=>world.state.outcome,
    pollCheckpoint(world){const id=world.state.pendingCheckpointId;world.state.pendingCheckpointId=null;return id;},
    isSimulating:world=>world.state.phase==='running',controllersChanged:(world,controllers)=>world.setControllers(controllers),onRewind:(world,meta)=>world.afterRewind(meta),release:world=>world.dispose(),
  };
}
export { TyagaWorld, PHYSICS_BUILD_HASH } from './world';
