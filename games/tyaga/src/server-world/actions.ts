import RAPIER from '@dimforge/rapier3d-compat';
import { BODY, PHYSICS } from '../core/config';
import { add, clamp, distance, length, localPoint, norm, Q, rotate, sub, V, worldPoint, yaw, yawQuat } from '../core/math';
import type { ActionResult, InteractionView, ItemKind, MapZone, SocketView, TyagaAction, Vec3 } from '../core/types';
import type { OperationRecord } from './state';
import type { TyagaWorld } from './world';
import { socketsFor } from './objects';
import { rememberTutorialWinchRelease } from '../tutorial';

export const MESSAGES:Record<string,{ru:string;en:string}>={
  OK:{ru:'Готово',en:'Done'},STARTED:{ru:'Выполняется',en:'In progress'},NOT_FOUND:{ru:'Предмет уже недоступен',en:'The item is no longer available'},
  TOO_FAR:{ru:'Подойдите ближе',en:'Move closer'},BLOCKED:{ru:'Между вами препятствие',en:'An obstacle blocks your reach'},BUSY:{ru:'Уже занято',en:'Already in use'},
  INVALID_ACTION:{ru:'Действие недоступно',en:'This action is unavailable'},NOT_HUMAN:{ru:'Это решение принимает человек',en:'A human must make this decision'},
  FINISHED:{ru:'Экспедиция завершена',en:'The expedition has ended'},FAILED:{ru:'Вернитесь на стоянку',en:'Return to your saved camp'},
  VOTING:{ru:'Сначала закончите голосование',en:'Finish the crew vote first'},HANDS_BUSY:{ru:'Сначала отпустите предмет',en:'Release the item first'},
  HANDLE_BUSY:{ru:'Эту ручку уже держат',en:'This handle is occupied'},MAX_HANDS:{ru:'Крупный груз удерживают не более двоих',en:'At most two people may hold the main cargo'},
  NOT_STORED:{ru:'Предмет уже извлечён',en:'The item is already unpacked'},NO_SPACE:{ru:'Освободите место',en:'Clear some space'},NO_SUPPORT:{ru:'Нужна устойчивая опора',en:'A stable support is needed'},
  MOVING:{ru:'Сначала остановитесь',en:'Stop first'},ATTACHED:{ru:'Сначала снимите крепления',en:'Remove the attachments first'},NO_ITEM:{ru:'Нет подходящего предмета',en:'No suitable item is available'},
  TOO_LONG:{ru:'Точка слишком далеко',en:'The attachment point is too far'},SOCKET_OCCUPIED:{ru:'Проушина уже занята',en:'This socket is occupied'},
  STRAP_BLOCKED:{ru:'Ремень проходит через препятствие',en:'The strap would pass through an obstacle'},ROPE_BLOCKED:{ru:'Трос пересекает корпус или препятствие. Разверните лебёдку или выберите другую точку.',en:'The cable crosses a housing or obstacle. Turn the winch or choose another attachment.'},ANCHOR_MATERIAL:{ru:'Якорь устанавливается в грунт или грязь',en:'Ground anchors need soil or mud'},
  SLOPE:{ru:'Опора слишком наклонена',en:'The support is too steep'},NO_REPAIR:{ru:'Требуется ремонт механизма',en:'The mechanism needs repair'},CARGO_NO_REPAIR:{ru:'Груз в поле не ремонтируется',en:'Cargo cannot be repaired in the field'},SUPPORTED_LOAD:{ru:'Уберите людей и груз с предмета',en:'Remove people and cargo from this item'},
  ALREADY_FULL:{ru:'Ремонт не требуется',en:'No repair is needed'},ROPE_BUSY:{ru:'Сначала остановите лебёдку',en:'Stop the winch first'},CONFIRM_TENSION:{ru:'Трос нагружен. Удерживайте снятие',en:'Cable under load. Hold to detach'},
  ALIGN:{ru:'Подведите настоящие детали к креплениям',en:'Bring the parts into alignment'},FERRY_LOCKS:{ru:'Закройте все четыре замка',en:'Close all four ferry locks'},NO_DRIVE:{ru:'Сначала установите привод',en:'Install the drive first'},
  BARRIER:{ru:'Закройте оба барьера',en:'Close both barriers'},OPENING_BLOCKED:{ru:'В проёме находится предмет',en:'An object is in the opening'},
  NO_BOT:{ru:'Выберите помощника',en:'Choose a bot helper'},COOLDOWN:{ru:'Подождите перед повтором',en:'Wait before trying again'},
  BRING_TRUCK:{ru:'Поставьте машину целиком в зону',en:'Park the whole truck inside the zone'},BRING_CARGO:{ru:'Доставьте в зону все три груза',en:'Bring all three cargoes inside the zone'},
  CREW_MISSING:{ru:'Дождитесь всей команды в зоне',en:'Gather the whole crew inside the zone'},RELEASE_CONTROLS:{ru:'Отпустите предметы и органы управления',en:'Release objects and controls'},
  OPERATION_ACTIVE:{ru:'Закончите текущую работу',en:'Finish the current operation'},EXTERNAL_CABLE:{ru:'Снимите крепление к внешней опоре',en:'Detach the cable leading outside the zone'},
  WAIT_STILL:{ru:'Постойте спокойно три секунды',en:'Stay still for three seconds'},VOTE_COOLDOWN:{ru:'Подождите перед новым голосованием',en:'Wait before starting another vote'},
  HOST_ONLY:{ru:'Завершить попытку может создатель комнаты',en:'Only the room owner can end the attempt'},TRAINING_ONLY:{ru:'Доступно на учебной площадке',en:'Available in training'},
  NO_CHECKPOINT:{ru:'Сначала сохраните стоянку',en:'Save a camp first'},CAPACITY:{ru:'В ящике недостаточно места',en:'The equipment locker is full'},RESCUE_COOLDOWN:{ru:'Спасение ещё недоступно',en:'Rescue is not ready yet'},
};
export function reply(code='OK',ok=code==='OK'||code==='STARTED'):ActionResult{return{result:{ok,code,message:MESSAGES[code]??MESSAGES.INVALID_ACTION}};}
function fail(code:string):never {throw new Error(code);}
function checkReach(w:TyagaWorld,pid:string,id:string,socket?:string,range?:number,consumedItemId?:string):void{const r=w.canReach(pid,id,socket,range,consumedItemId);if(!r.ok)fail(r.code);}
function finiteVector(v:unknown):v is Vec3{return Boolean(v&&typeof v==='object'&&['x','y','z'].every(k=>Number.isFinite((v as Record<string,unknown>)[k])));}
function parseAction(value:unknown):TyagaAction{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_ACTION');
  const o=value as Record<string,unknown>;if(typeof o.type!=='string')fail('INVALID_ACTION');
  const fields:Record<string,string[]>={appearance:['head','backpack'],jump:[],interact:['targetId','socketId'],release:[],grab:['itemId','handleId'],unpack:['itemId','position','angle'],pack:['itemId'],unfold:['itemId'],rotate:['direction'],attach:['fromId','fromSocket','toId','toSocket','itemId','kind'],detach:['connectionId','confirm'],anchor:['itemId'],extract:['itemId'],jack:['itemId','targetId'],repair:['targetId','itemId'],operate:['targetId'],barrier:['targetId','closed'],'install-drive':['itemId','targetId'],'remove-drive':['targetId'],'launch-ferry':[],brake:['enabled'],rescue:[],'bot-order':['participantId','task','targetId','point'],checkpoint:['checkpointId'],rewind:[],finish:[],vote:['yes'],cancel:[],'end-attempt':[],'tutorial-retry':[],'tutorial-skip':[]};
  const allowed=fields[o.type];if(!allowed||Object.keys(o).some(k=>k!=='type'&&!allowed.includes(k)))fail('INVALID_ACTION');
  for(const [key,v]of Object.entries(o)){
    if(['position','point'].includes(key)){if(!finiteVector(v))fail('INVALID_ACTION');}
    else if(['angle','direction','head','backpack'].includes(key)){if(typeof v!=='number'||!Number.isFinite(v))fail('INVALID_ACTION');}
    else if(['enabled','closed','yes','confirm'].includes(key)){if(typeof v!=='boolean')fail('INVALID_ACTION');}
    else if(typeof v!=='string'||v.length>128)fail('INVALID_ACTION');
  }
  const required:Record<string,string[]>={appearance:['head','backpack'],grab:['itemId'],unpack:['itemId'],pack:['itemId'],unfold:['itemId'],rotate:['direction'],attach:['fromId','fromSocket','toId','toSocket'],detach:['connectionId'],anchor:['itemId'],extract:['itemId'],jack:['itemId','targetId'],repair:['targetId'],operate:['targetId'],barrier:['targetId','closed'],'install-drive':['itemId','targetId'],'remove-drive':['targetId'],brake:['enabled'],'bot-order':['participantId','task'],vote:['yes']};
  if((required[o.type]??[]).some(k=>o[k]===undefined))fail('INVALID_ACTION');
  return o as unknown as TyagaAction;
}
function start(w:TyagaWorld,pid:string,action:TyagaAction,duration:number,targetId:string):ActionResult{
  if(w.state.operations[pid])fail('BUSY');const c=w.state.characters[pid];w.state.operations[pid]={participantId:pid,action,duration,remaining:duration,startPosition:{...w.body(c.bodyId).translation()},targetId};w.emit('operation-start',targetId,pid);return reply('STARTED');
}
function character(w:TyagaWorld,pid:string){const c=w.state.characters[pid];if(!c)fail('NOT_FOUND');return c;}
function itemWorld(w:TyagaWorld,id:string,kind?:ItemKind){const item=w.state.inventory[id];if(!item||item.state!=='world'||!w.state.entities[item.bodyId??id]?.active||kind&&item.kind!==kind)fail('NO_ITEM');return item;}
function clearAt(w:TyagaWorld,position:Vec3,size:Vec3,rotation=Q(),excludeId?:string):boolean{
  w.physics.propagateModifiedBodyPositionsToColliders();const hit=w.physics.intersectionWithShape(position,rotation,new RAPIER.Cuboid(size.x*.49,size.y*.49,size.z*.49),undefined,undefined,undefined,excludeId?w.maybeBody(excludeId)??undefined:undefined,c=>(c.collisionGroups()&0xffff)!==0&&w.state.entities[w.state.colliderBodies[c.handle]]?.kind!=='rope-segment');return !hit;
}
function heldBy(w:TyagaWorld,id:string):string[]{return Object.values(w.state.characters).filter(c=>c.holding?.itemId===id).map(c=>c.participant.participantId);}
function packedVolume(kind:ItemKind):number{if(kind==='deck')return 1.5*1.5*.4;const s=BODY[kind].size;return s.x*s.y*s.z;}
function strapPathClear(w:TyagaWorld,fromId:string,from:SocketView,toId:string,to:SocketView,itemId:string,actorId:string):boolean{
  const d=distance(from.world,to.world),ray=new RAPIER.Ray(from.world,norm(sub(to.world,from.world)));let clear=true;
  w.physics.intersectionsWithRay(ray,d,true,hit=>{
    const id=w.state.colliderBodies[hit.collider.handle];
    // Eyelets are slightly inset in the source meshes. Permit only their
    // short terminal entry, never a path through an entire endpoint body.
    if(id===fromId&&hit.timeOfImpact<.025){const exit=hit.collider.castRay(ray,d,false),eyeClearance=w.state.entities[id]?.kind==='winch'?.65:.25;if(exit>=0&&exit<=eyeClearance)return true;}
    if(id===toId&&hit.timeOfImpact>=d-(w.state.entities[id]?.kind==='winch'?.65:.25))return true;
    clear=false;return false;
  },undefined,undefined,undefined,undefined,collider=>(collider.collisionGroups()&0xffff)!==0&&w.state.colliderBodies[collider.handle]!==itemId&&w.state.colliderBodies[collider.handle]!==actorId);
  return clear;
}
function ropePathClear(w:TyagaWorld,fromId:string,from:SocketView,toId:string,to:SocketView):boolean{
  const d=distance(from.world,to.world),ray=new RAPIER.Ray(from.world,norm(sub(to.world,from.world)));let clear=true;
  w.physics.intersectionsWithRay(ray,d,true,hit=>{
    const id=w.state.colliderBodies[hit.collider.handle];
    // A drum outlet may be slightly inset, but the newly laid cable must
    // leave that local outlet, not cross any other part of its own housing.
    if(id===fromId&&hit.timeOfImpact<.025){const exit=hit.collider.castRay(ray,d,false);if(exit>=0&&exit<=.08)return true;}
    if(id===toId&&hit.timeOfImpact>=d-.25)return true;
    clear=false;return false;
  },undefined,undefined,undefined,undefined,collider=>(collider.collisionGroups()&0xffff)!==0&&w.state.entities[w.state.colliderBodies[collider.handle]]?.kind!=='character');
  return clear;
}

export function performAction(w:TyagaWorld,pid:string,value:unknown):ActionResult{
  try{
    const a=parseAction(value),c=character(w,pid);const state=w.state;
    if(a.type==='appearance'){if(![0,1].includes(a.head)||![0,1].includes(a.backpack))fail('INVALID_ACTION');c.participant.appearance={head:a.head,backpack:a.backpack};return reply();}
    if(state.phase==='finished')return reply('FINISHED',false);
    if(state.vote&&!['vote','cancel','end-attempt'].includes(a.type))return reply('VOTING',false);
    if(state.phase==='failed'&&!['rewind','vote','cancel','end-attempt'].includes(a.type))return reply('FAILED',false);
    // A failed world pauses personal rescue. Decisions must remain reachable
    // so the crew can restore a checkpoint or end the attempt while falling.
    if(c.rescueAt!==null&&!['rewind','vote','cancel','end-attempt'].includes(a.type))return reply('BUSY',false);
    switch(a.type){
      case 'jump':{
        if(c.controlling)fail('BUSY');if(!c.grounded||state.tick-c.jumpTick<15)fail('NO_SUPPORT');const body=w.body(c.bodyId);body.applyImpulse(V(0,80*PHYSICS.jump,0),true);c.grounded=false;c.jumpTick=state.tick;w.emit('jump',c.bodyId,pid);return reply();
      }
      case 'interact':{
        const options=interactionsFor(w,pid).filter(i=>i.enabled&&(!a.targetId||i.targetId===a.targetId)&&i.action.type!=='interact');
        if(!options.length)fail('TOO_FAR');return performAction(w,pid,options[0].action);
      }
      case 'release':{
        const driving=c.controlling==='truck';const old=w.body(c.bodyId).translation();let exit:Vec3|null=null;
        if(driving){const truck=w.body('truck');if(length(truck.linvel())>1)fail('MOVING');for(const z of [2,-2,2.8,-2.8]){const p=worldPoint(truck.translation(),truck.rotation(),V(2.3,0,z));const g=w.ground(add(p,V(0,2,0)),5,'truck');if(g){const target=add(g.point,V(0,.91,0));if(clearAt(w,target,V(.6,1.75,.6),Q(),c.bodyId)){exit=target;break;}}}if(!exit)fail('NO_SPACE');}
        const held=c.holding?.itemId;rememberTutorialWinchRelease(w,pid);w.releaseCharacter(pid);if(exit){const b=w.body(c.bodyId);b.setTranslation(exit,true);b.setRotation(Q(),true);b.setLinvel(V(),true);}w.emit('released',held??c.bodyId,pid);if(!driving)c.lastPosition={...old};return reply();
      }
      case 'grab':{
        const e=state.entities[a.itemId];if(!e?.active||e.fixed||['truck','ring','rope-segment','character','lift'].includes(e.kind))fail('NOT_FOUND');if(c.controlling)fail('BUSY');if(c.holding)fail('HANDS_BUSY');
        const body=w.body(c.bodyId);const handle=a.handleId?w.socket(a.itemId,a.handleId):w.closestSocket(a.itemId,body.translation(),'handle');if(!handle||handle.role!=='handle')fail('NOT_FOUND');checkReach(w,pid,a.itemId,handle.id);if(handle.occupiedBy)fail('HANDLE_BUSY');if(heldBy(w,a.itemId).length>=2)fail('MAX_HANDS');
        const relative=sub(handle.world,body.translation());
        c.holding={itemId:a.itemId,handleId:handle.id,offset:{x:clamp(relative.x,-1,1),y:clamp(relative.y+.6,-.1,.5),z:clamp(relative.z,-1,1)},since:state.worldTime,...(w.body(a.itemId).mass()<=55?{yawTarget:yaw(w.body(a.itemId).rotation())}:{})};w.emit('grabbed',a.itemId,pid);return reply();
      }
      case 'unpack':{
        const item=state.inventory[a.itemId];if(!item||item.state!=='stored')fail('NOT_STORED');checkReach(w,pid,'equipment-crate');
        if(c.controlling||c.holding)fail('HANDS_BUSY');const p=w.body(c.bodyId).translation();const direction=rotate(yawQuat(c.heading),V(1.2,0,0));let position=a.position??add(p,direction);if(distance(position,p)>2)fail('TOO_FAR');
        const size=item.kind==='deck'?V(1.5,.4,1.5):BODY[item.kind].size;const support=w.ground(add(position,V(0,1,0)),4,c.bodyId);if(!support)fail('NO_SUPPORT');position=V(position.x,support.point.y+size.y/2+.04,position.z);
        if(!clearAt(w,position,size,yawQuat(a.angle??0)))fail('NO_SPACE');return start(w,pid,{...a,position},1,'equipment-crate');
      }
      case 'pack':{
        const item=itemWorld(w,a.itemId);checkReach(w,pid,item.bodyId??item.id);checkReach(w,pid,'equipment-crate');if(length(w.body(item.bodyId??item.id).linvel())>.1)fail('MOVING');if(heldBy(w,a.itemId).length||Object.values(state.links).some(l=>!l.broken&&(l.fromId===a.itemId||l.toId===a.itemId)))fail('ATTACHED');
        if(w.hasSupportedLoad(a.itemId))fail('SUPPORTED_LOAD');
        const cap=Object.entries(w.map.tools).reduce((n,[k,count])=>n+packedVolume(k as ItemKind)*count,0);const volume=Object.values(state.inventory).filter(i=>i.state==='stored').reduce((n,i)=>n+packedVolume(i.kind),0);if(volume+packedVolume(item.kind)>cap+.001)fail('CAPACITY');return start(w,pid,a,1,a.itemId);
      }
      case 'unfold':{
        const item=itemWorld(w,a.itemId,'deck');checkReach(w,pid,item.bodyId??item.id);const e=state.entities[a.itemId];if(!e.folded)fail('INVALID_ACTION');const b=w.body(a.itemId),p=b.translation();const size=BODY.deck.size;const pos=V(p.x,p.y-e.size.y/2+size.y/2,p.z);if(!clearAt(w,pos,size,b.rotation(),a.itemId))fail('NO_SPACE');
        const support=w.ground(add(pos,rotate(b.rotation(),V(-1.8,.2,0))),1,a.itemId)??w.ground(add(pos,rotate(b.rotation(),V(1.8,.2,0))),1,a.itemId);if(!support)fail('NO_SUPPORT');return start(w,pid,a,1,a.itemId);
      }
      case 'rotate':{
        if(a.direction!==1&&a.direction!==-1)fail('INVALID_ACTION');if(!c.holding)fail('HANDS_BUSY');const b=w.body(c.holding.itemId);
        if(b.mass()<=55)c.holding.yawTarget=(c.holding.yawTarget??yaw(b.rotation()))+a.direction*Math.PI/12;
        else{b.applyTorqueImpulse(V(0,a.direction*Math.min(45,b.mass()*.25),0),true);c.holding.offset=rotate(yawQuat(a.direction*Math.PI/12),c.holding.offset);c.heading+=a.direction*Math.PI/12;}
        w.emit('rotated',c.holding.itemId,pid);return reply();
      }
      case 'attach':{
        const from=w.socket(a.fromId,a.fromSocket),to=w.socket(a.toId,a.toSocket);if(!from||!to||a.fromId===a.toId)fail('NOT_FOUND');const kind=a.kind??'strap';if(!['strap','rope','deck','ferry-lock'].includes(kind))fail('INVALID_ACTION');
        const strap=kind==='strap'?(a.itemId?state.inventory[a.itemId]:Object.values(state.inventory).find(i=>i.kind==='strap'&&(i.state==='stored'||i.state==='world'))):undefined;
        if(kind==='strap'&&(!strap||strap.kind!=='strap'||!['stored','world'].includes(strap.state)))fail('NO_ITEM');
        // The selected loose unit is picked up by this operation; it cannot
        // obstruct its own eyelet. Its own reach is still checked separately.
        const consumedItemId=strap?.state==='world'?(strap.bodyId??strap.id):undefined;
        const existing=kind==='rope'?Object.values(state.links).find(l=>l.kind==='rope'&&l.fromId===a.fromId&&l.spoolMass):undefined;
        if(existing?.detached&&existing.hookId){checkReach(w,pid,existing.hookId,'handle-0');checkReach(w,pid,a.toId,a.toSocket);}else checkReach(w,pid,a.fromId,a.fromSocket,undefined,consumedItemId);const d=distance(from.world,to.world);
        if(kind==='rope'){
          if((a.fromId!=='truck'&&state.entities[a.fromId]?.kind!=='winch')||a.fromSocket!==(a.fromId==='truck'?'front-winch':'drum'))fail('INVALID_ACTION');if(d>18||!existing&&d<1.5)fail('TOO_LONG');
          if(existing?.broken)fail('NO_REPAIR');if(existing&&!existing.detached)fail('BUSY');if(existing?.hookId&&distance(w.body(existing.hookId).translation(),to.world)>.3)fail('ALIGN');
          if(!['ring','lock','handle'].includes(to.role))fail('INVALID_ACTION');
          if(!existing&&!ropePathClear(w,a.fromId,from,a.toId,to))fail('ROPE_BLOCKED');
          return start(w,pid,a,1,existing?.hookId??a.fromId);
        }
        if(kind==='strap'){
          if(from.role!=='ring'||to.role!=='ring')fail('INVALID_ACTION');if(d>2)fail('TOO_LONG');
          const item=strap!;if(item.state==='stored')checkReach(w,pid,'equipment-crate');else checkReach(w,pid,item.bodyId??item.id);
          if(!strapPathClear(w,a.fromId,from,a.toId,to,item.id,c.bodyId))fail('STRAP_BLOCKED');return start(w,pid,{...a,itemId:item.id,kind},2,a.fromId);
        }
        if(kind==='deck'){
          if(state.entities[a.fromId]?.kind!=='deck'||!state.entities[a.toId]?.fixed||from.role!=='ring'||to.role!=='ring')fail('INVALID_ACTION');if(d>.3)fail('ALIGN');const e=state.entities[a.fromId];if(e.folded)fail('INVALID_ACTION');
          const p=from.world;const support=w.ground(add(p,V(0,.2,0)),.65,a.fromId);if(!support||Math.abs(support.point.y-p.y)>.4)fail('NO_SUPPORT');
          const edge=rotate(w.body(a.fromId).rotation(),V(Math.sign(from.local.x)*-.25,0,0));if(!w.ground(add(p,add(edge,V(0,.2,0))),.65,a.fromId))fail('NO_SUPPORT');
        }else if(kind==='ferry-lock'){
          if(state.entities[a.fromId]?.kind!=='ferry-deck'||state.entities[a.toId]?.kind!=='pontoon'||from.role!=='lock'||to.role!=='lock')fail('INVALID_ACTION');if(d>.3)fail('ALIGN');
        }
        if(Object.values(state.links).some(l=>!l.broken&&((l.fromId===a.fromId&&l.fromSocket===a.fromSocket)||(l.toId===a.toId&&l.toSocket===a.toSocket))))fail('SOCKET_OCCUPIED');return start(w,pid,{...a,kind},1,a.fromId);
      }
      case 'detach':{
        const link=state.links[a.connectionId];if(!link||link.broken)fail('NOT_FOUND');const r=w.canReach(pid,link.fromId,link.fromSocket);if(!r.ok)checkReach(w,pid,link.toId,link.toSocket);
        if(link.kind==='rope'&&link.tension>1500&&!a.confirm)fail('CONFIRM_TENSION');return start(w,pid,a,1,link.fromId);
      }
      case 'anchor':{
        itemWorld(w,a.itemId,'anchor');checkReach(w,pid,a.itemId);const e=state.entities[a.itemId];if(e.anchored)fail('ATTACHED');const b=w.body(a.itemId);const ground=w.ground(b.translation(),2,a.itemId);if(!ground)fail('NO_SUPPORT');if(!['soil','mud'].includes(ground.material))fail('ANCHOR_MATERIAL');if(ground.normal.y<Math.cos(25*Math.PI/180))fail('SLOPE');
        const truck=w.body('truck');const inTruck=localPoint(truck.translation(),truck.rotation(),b.translation());if(Math.abs(inTruck.x)<3.2&&Math.abs(inTruck.z)<1.3)fail('NO_SPACE');return start(w,pid,a,3,a.itemId);
      }
      case 'extract':{
        const e=state.entities[a.itemId];if(!e?.anchored)fail('NOT_FOUND');checkReach(w,pid,a.itemId);if(Object.values(state.links).some(l=>!l.broken&&(l.fromId===a.itemId||l.toId===a.itemId)))fail('ATTACHED');return start(w,pid,a,3,a.itemId);
      }
      case 'jack':{
        itemWorld(w,a.itemId,'jack');checkReach(w,pid,a.itemId);const target=state.entities[a.targetId];if(!target?.active||target.fixed||target.kind==='character')fail('INVALID_ACTION');const b=w.body(a.itemId),ground=w.ground(b.translation(),1,a.itemId);if(!ground)fail('NO_SUPPORT');if(ground.normal.y<Math.cos(12*Math.PI/180))fail('SLOPE');
        for(const x of [-.18,.18])for(const z of [-.18,.18])if(!w.ground(add(b.translation(),V(x,0,z)),.8,a.itemId))fail('NO_SUPPORT');
        const targetBody=w.body(a.targetId);const local=localPoint(targetBody.translation(),targetBody.rotation(),b.translation());local.y=target.kind==='truck'?-.44:-target.size.y/2;if(Math.abs(local.x)>target.size.x/2+.3||Math.abs(local.z)>target.size.z/2+.3)fail('ALIGN');
        state.machinery.jacks[a.itemId]={targetId:a.targetId,targetSocket:local,height:0,origin:{...b.translation()}};c.controlling=a.itemId;c.holding=null;w.emit('jack-installed',a.itemId,pid);return reply();
      }
      case 'repair':{
        const link=state.links[a.targetId];const e=state.entities[a.targetId];if(a.targetId!=='truck'&&!link&&a.targetId!=='lift-platform')fail('CARGO_NO_REPAIR');
        if(link){if(link.kind!=='rope'||!link.broken)fail('NO_REPAIR');checkReach(w,pid,link.fromId,link.fromSocket);if(Object.values(state.characters).some(p=>p.controlling===link.id))fail('ROPE_BUSY');if(link.collarId&&distance(w.body(link.collarId).translation(),w.socket(link.fromId,link.fromSocket)!.world)>.3)fail('ALIGN');}
        else {checkReach(w,pid,a.targetId);if(a.targetId==='truck'&&(e.integrity??100)>=100)fail('ALREADY_FULL');if(length(w.body(a.targetId).linvel())>.2)fail('MOVING');if(a.targetId==='lift-platform'&&!state.machinery.lift?.cableBroken)fail('ALREADY_FULL');}
        const item=a.itemId?state.inventory[a.itemId]:Object.values(state.inventory).find(i=>i.kind==='repair'&&['stored','world'].includes(i.state));if(!item||item.kind!=='repair'||!['stored','world'].includes(item.state))fail('NO_ITEM');if(item.state==='stored')checkReach(w,pid,'equipment-crate');else checkReach(w,pid,item.id);
        return start(w,pid,{...a,itemId:item.id},link?3:4,a.targetId);
      }
      case 'operate':{
        if(c.controlling||c.holding)fail('HANDS_BUSY');const link=state.links[a.targetId];
        if(link){if(link.kind!=='rope'||link.broken)fail('NOT_FOUND');checkReach(w,pid,link.fromId,link.fromSocket);if(Object.values(state.characters).some(x=>x.controlling===link.id))fail('BUSY');c.controlling=link.id;return reply();}
        const e=state.entities[a.targetId];if(!e?.active)fail('NOT_FOUND');
        if(a.targetId==='truck'){
          if(state.truck.driver)fail('BUSY');if(length(w.body('truck').linvel())>1)fail('MOVING');const body=w.body(c.bodyId);const cab=w.closestSocket('truck',body.translation(),'cab')!;checkReach(w,pid,'truck',cab.id);
          const truck=w.body('truck'),seat=V(2.5,.65,0);body.setTranslation(worldPoint(truck.translation(),truck.rotation(),seat),true);body.setRotation(truck.rotation(),true);body.setLinvel(truck.linvel(),true);body.lockRotations(false,true);for(const h of state.entities[c.bodyId].colliders)w.physics.getCollider(h).setCollisionGroups(0x00010000);
          const joint=w.physics.createImpulseJoint(RAPIER.JointData.fixed(seat,Q(),V(),Q()),truck,body,true);joint.setContactsEnabled(false);c.seatJoint=joint.handle;c.controlling='truck';state.truck.driver=pid;state.truck.brake=true;w.emit('driver','truck',pid);return reply();
        }
        if(a.targetId==='rear-brake'){checkReach(w,pid,'truck','rear-brake');state.truck.brakeHolder=pid;c.controlling='rear-brake';return reply();}
        if(e.kind==='winch'){checkReach(w,pid,a.targetId,'drum');const rope=Object.values(state.links).find(l=>l.kind==='rope'&&!l.broken&&l.fromId===a.targetId);if(!rope)fail('NOT_FOUND');c.controlling=rope.id;return reply();}
        if(e.kind==='jack'){checkReach(w,pid,a.targetId,'control');if(!state.machinery.jacks[a.targetId])fail('NO_SUPPORT');if(Object.values(state.characters).some(x=>x.controlling===a.targetId))fail('BUSY');c.controlling=a.targetId;return reply();}
        if(e.kind==='ferry-deck'){
          const ferry=state.machinery.ferry;if(!ferry?.driveId)fail('NO_DRIVE');if(!ferry.launched)fail('NO_SUPPORT');if(ferry.operator)fail('BUSY');checkReach(w,pid,a.targetId,'control');ferry.operator=pid;c.controlling=a.targetId;return reply();
        }
        if(e.kind==='lift'||['lift-lower-control','lift-transmission'].includes(a.targetId)){
          const lift=state.machinery.lift;if(!lift?.driveId)fail('NO_DRIVE');if(lift.operator)fail('BUSY');checkReach(w,pid,a.targetId,'control');if(!Object.values(lift.barriers).every(Boolean))fail('BARRIER');if(lift.cableBroken)fail('NO_REPAIR');lift.operator=pid;c.controlling='lift-platform';return reply();
        }
        return fail('INVALID_ACTION');
      }
      case 'barrier':{
        const lift=state.machinery.lift;if(!lift||!(a.targetId in lift.barriers))fail('NOT_FOUND');checkReach(w,pid,a.targetId,'control');if(Math.abs(w.body('lift-platform').linvel().y)>.05)fail('MOVING');
        const e=state.entities[a.targetId],b=w.body(a.targetId);if(a.closed&&!clearAt(w,b.translation(),e.size,b.rotation(),a.targetId))fail('OPENING_BLOCKED');lift.barriers[a.targetId]=a.closed;for(const h of e.colliders)w.physics.getCollider(h).setCollisionGroups(a.closed?0xffffffff:0x00010000);w.emit('barrier',a.targetId,pid);return reply();
      }
      case 'install-drive':{
        itemWorld(w,a.itemId,'drive');checkReach(w,pid,a.itemId,'handle-0');const target=a.targetId==='lift-platform'?'lift-transmission':a.targetId;if(!['ferry-deck','lift-transmission'].includes(target))fail('INVALID_ACTION');checkReach(w,pid,target,'drive');const socket=w.socket(target,'drive')!;const drive=w.socket(a.itemId,'drive')!;if(distance(socket.world,drive.world)>.3)fail('ALIGN');if(target==='ferry-deck'&&state.machinery.ferry?.driveId||target==='lift-transmission'&&state.machinery.lift?.driveId)fail('BUSY');if(heldBy(w,a.itemId).some(id=>id!==pid))fail('HANDS_BUSY');
        const result=start(w,pid,{...a,targetId:target},2,a.itemId);if(c.holding?.itemId===a.itemId)c.holding=null;
        // The clamp guide suppresses contact only between the two mating
        // bodies. Its six axes remain free; finite forces align the parts.
        const guide=w.physics.createImpulseJoint(RAPIER.JointData.generic(socket.local,drive.local,V(1,0,0),0 as RAPIER.JointAxesMask),w.body(target),w.body(a.itemId),true);guide.setContactsEnabled(false);state.operations[pid].guideJoint=guide.handle;return result;
      }
      case 'remove-drive':{
        const target=a.targetId==='lift-platform'?'lift-transmission':a.targetId;const driveId=target==='ferry-deck'?state.machinery.ferry?.driveId:state.machinery.lift?.driveId;if(!driveId)fail('NO_DRIVE');checkReach(w,pid,target,'drive');if(target==='ferry-deck'&&state.machinery.ferry?.operator||target==='lift-transmission'&&state.machinery.lift?.operator)fail('MOVING');return start(w,pid,{...a,targetId:target},1,driveId);
      }
      case 'launch-ferry':{
        const ferry=state.machinery.ferry;if(!ferry||ferry.launched)fail('INVALID_ACTION');checkReach(w,pid,'ferry-deck','control');if(Object.values(state.links).filter(l=>l.kind==='ferry-lock'&&!l.broken&&l.fromSocket.startsWith('lock-')).length!==4)fail('FERRY_LOCKS');if(!ferry.driveId)fail('NO_DRIVE');for(const h of ferry.supportHandles){const b=w.physics.getRigidBody(h);if(b)w.physics.removeRigidBody(b);}ferry.supportHandles=[];ferry.launched=true;w.emit('ferry-launched','ferry-deck',pid);return reply();
      }
      case 'brake':{
        if(c.controlling!=='truck'){checkReach(w,pid,'truck','rear-brake');if(a.enabled){state.truck.brakeHolder=pid;c.controlling='rear-brake';}else if(state.truck.brakeHolder===pid){state.truck.brakeHolder=null;c.controlling=null;}else fail('BUSY');}
        else state.truck.brake=a.enabled;w.emit('brake','truck',pid);return reply();
      }
      case 'rescue':{if(c.rescueCooldown>0)fail('RESCUE_COOLDOWN');return start(w,pid,a,2,c.bodyId);}
      case 'bot-order':{
        if(c.controller.kind!=='human'||!c.controller.connected)fail('NOT_HUMAN');const bot=state.characters[a.participantId];if(!bot||bot.controller.kind!=='bot')fail('NO_BOT');if(!['follow','carry','hold','winch','secure','drive'].includes(a.task))fail('INVALID_ACTION');
        if(a.targetId&&!state.entities[a.targetId]?.active&&!state.links[a.targetId])fail('NOT_FOUND');if(a.point&&(a.point.x<0||a.point.x>w.map.bounds.x||a.point.z<0||a.point.z>w.map.bounds.z))fail('INVALID_ACTION');
        w.releaseCharacter(a.participantId);bot.task={kind:a.task,targetId:a.targetId,point:a.point,status:'accepted',requestedBy:pid,failures:0,failedAt:0};w.emit('bot-order',a.targetId,a.participantId,undefined,{ru:'Поручение принято',en:'Task accepted'});return reply();
      }
      case 'checkpoint':case 'rewind':case 'finish':{
        if(c.controller.kind!=='human'||!c.controller.connected)fail('NOT_HUMAN');if(state.voteCooldown>0)fail('VOTE_COOLDOWN');
        let checkpointId:string|undefined;
        if(a.type==='checkpoint'){
          const zone=a.checkpointId?w.map.checkpoints.find(z=>z.id===a.checkpointId):w.map.checkpoints.find(z=>w.zoneContains(z,'truck'));if(!zone)fail('BRING_TRUCK');const ready=zoneConditions(w,zone);if(!ready.ok)fail(ready.code);if((state.zoneReadySeconds[zone.id]??0)<3)fail('WAIT_STILL');checkpointId=zone.id;
        }else if(a.type==='finish'){
          if(w.map.id==='tutorial')fail('TRAINING_ONLY');const ready=zoneConditions(w,w.map.finish);if(!ready.ok)fail(ready.code);if((state.zoneReadySeconds[w.map.finish.id]??0)<3)fail('WAIT_STILL');
        }else checkpointId=state.checkpointId;
        const voters=Object.values(state.characters).filter(x=>x.controller.kind==='human'&&x.controller.connected).map(x=>x.participant.participantId);
        state.vote={kind:a.type==='checkpoint'?'checkpoint':a.type==='finish'?'finish':'rewind',initiator:pid,checkpointId,voters,yes:[pid],remaining:30,controllerFingerprint:w.controllerFingerprint()};state.phase='voting';for(const id of Object.keys(state.characters))w.inputs[id]={moveX:0,moveZ:0,run:false,throttle:0,steer:0,brake:true,tool:0};w.emit('vote',undefined,pid);return completeVote(w);
      }
      case 'vote':{
        if(!state.vote||!state.vote.voters.includes(pid)||c.controller.kind!=='human'||!c.controller.connected)fail('INVALID_ACTION');if(!a.yes){w.cancelVote('DECLINED');return reply();}if(!state.vote.yes.includes(pid))state.vote.yes.push(pid);return completeVote(w);
      }
      case 'cancel':{
        if(state.vote){if(state.vote.initiator!==pid)fail('BUSY');w.cancelVote('CANCELLED');}w.cancelOperation(pid);return reply();
      }
      case 'end-attempt':{
        if(pid!==Object.values(state.characters).find(x=>!x.participant.bot)?.participant.participantId)fail('HOST_ONLY');state.vote=null;state.phase='finished';state.outcome={outcomeId:`${state.matchId}:abandoned`,success:false,mapId:w.map.id,mode:state.mode,elapsedSeconds:state.elapsedSeconds,rewinds:state.rewinds,cargo:Object.values(state.entities).filter(e=>e.required&&e.id!=='truck').map(e=>({id:e.id,kind:e.kind,integrity:e.integrity??0})),truckIntegrity:state.entities.truck.integrity??0,careful:false,noRewinds:false};return reply();
      }
      case 'tutorial-retry':{
        if(w.map.id!=='tutorial')fail('TRAINING_ONLY');return { ...reply(),rewindTo:state.checkpointId };
      }
      case 'tutorial-skip':{
        if(w.map.id!=='tutorial')fail('TRAINING_ONLY');state.tutorial.completed=true;state.tutorial.step=8;w.emit('tutorial-complete',undefined,pid);return reply();
      }
    }
  }catch(error){return reply(error instanceof Error?error.message:'INVALID_ACTION',false);}
}

function completeVote(w:TyagaWorld):ActionResult{
  const s=w.state,v=s.vote;if(!v)return reply('INVALID_ACTION',false);if(v.yes.length<v.voters.length)return reply('STARTED');
  s.vote=null;s.phase='running';s.voteCooldown=0;
  if(v.kind==='checkpoint'){
    s.checkpointId=v.checkpointId!;if(w.map.id==='tutorial')s.tutorial.checkpointDone=true;w.emit('checkpoint',v.checkpointId);return{...reply(),checkpointId:v.checkpointId};
  }
  if(v.kind==='rewind'){w.emit('rewind-approved');return{...reply(),rewindTo:s.checkpointId};}
  const cargo=Object.values(s.entities).filter(e=>e.required&&e.id!=='truck').map(e=>({id:e.id,kind:e.kind,integrity:e.integrity??0}));
  s.outcome={outcomeId:`${s.matchId}:delivery`,success:true,mapId:w.map.id,mode:s.mode,elapsedSeconds:s.elapsedSeconds,rewinds:s.rewinds,cargo,truckIntegrity:s.entities.truck.integrity??0,careful:cargo.every(e=>e.integrity>=70),noRewinds:s.rewinds===0};s.phase='finished';w.emit('delivered','truck');return reply();
}

export function zoneConditions(w:TyagaWorld,zone:MapZone):{ok:boolean;code:string;message:{ru:string;en:string}}{
  const result=(code:string)=>({ok:code==='OK',code,message:MESSAGES[code]??MESSAGES.INVALID_ACTION});
  if(!zone||!w.zoneContains(zone,'truck'))return result('BRING_TRUCK');
  for(const e of Object.values(w.state.entities))if(e.required){if((e.integrity??0)<=0||!w.zoneContains(zone,e.id))return result('BRING_CARGO');const b=w.body(e.id);if(length(b.linvel())>=.15||length(b.angvel())>=.1)return result('MOVING');}
  for(const c of Object.values(w.state.characters)){if(!w.zoneContains(zone,c.bodyId)||!c.grounded)return result('CREW_MISSING');if(c.holding||c.controlling||c.rescueAt!==null)return result('RELEASE_CONTROLS');}
  if(Object.keys(w.state.operations).length)return result('OPERATION_ACTIVE');
  for(const l of Object.values(w.state.links))if(!l.broken&&l.tension>100&&(!w.zoneContains(zone,l.fromId)||!w.zoneContains(zone,l.toId)))return result('EXTERNAL_CABLE');
  return result('OK');
}

export function finishOperation(w:TyagaWorld,pid:string,operation:OperationRecord):void{
  const a=operation.action,c=character(w,pid),s=w.state;
  try{
    if(a.type==='unpack'){
      const item=s.inventory[a.itemId];if(!item||item.state!=='stored')fail('NOT_STORED');checkReach(w,pid,'equipment-crate');const size=item.kind==='deck'?V(1.5,.4,1.5):BODY[item.kind].size;const position=a.position!;if(!clearAt(w,position,size,yawQuat(a.angle??0)))fail('NO_SPACE');
      item.state='world';item.bodyId=item.id;w.addBody({id:item.id,kind:item.kind,position,size,rotation:yawQuat(a.angle??0),folded:item.kind==='deck'});w.updateMasses();w.emit('unpacked',item.id,pid);
    }else if(a.type==='pack'){
      const item=itemWorld(w,a.itemId);checkReach(w,pid,'equipment-crate');checkReach(w,pid,a.itemId);if(length(w.body(a.itemId).linvel())>.1||heldBy(w,a.itemId).length||Object.values(s.links).some(l=>!l.broken&&(l.fromId===a.itemId||l.toId===a.itemId)))fail('MOVING');if(w.hasSupportedLoad(a.itemId))fail('SUPPORTED_LOAD');w.removeBody(item.bodyId??item.id);item.state='stored';delete item.bodyId;w.updateMasses();w.emit('packed',a.itemId,pid);
    }else if(a.type==='unfold'){
      const e=s.entities[a.itemId];if(!e?.active||!e.folded)fail('NOT_FOUND');checkReach(w,pid,a.itemId);const b=w.body(a.itemId),p=b.translation(),size=BODY.deck.size;const target=V(p.x,p.y-e.size.y/2+size.y/2,p.z);if(!clearAt(w,target,size,b.rotation(),a.itemId))fail('NO_SPACE');
      b.setTranslation(target,true);w.unfoldDeckGeometry(a.itemId);e.size={...size};e.folded=false;e.sockets=socketsFor('deck',size);for(const id of heldBy(w,a.itemId))s.characters[id].holding=null;w.emit('unfolded',a.itemId,pid);
    }else if(a.type==='attach'){
      const from=w.socket(a.fromId,a.fromSocket),to=w.socket(a.toId,a.toSocket);if(!from||!to)fail('NOT_FOUND');const kind=a.kind??'strap';const existing=kind==='rope'?Object.values(s.links).find(l=>l.kind==='rope'&&l.fromId===a.fromId&&l.spoolMass):undefined;
      const item=kind==='strap'&&a.itemId?s.inventory[a.itemId]:undefined;
      const consumedItemId=item?.kind==='strap'&&item.state==='world'?(item.bodyId??item.id):undefined;
      if(existing?.detached&&existing.hookId){checkReach(w,pid,existing.hookId,'handle-0');checkReach(w,pid,a.toId,a.toSocket);}else checkReach(w,pid,a.fromId,a.fromSocket,undefined,consumedItemId);
      const d=distance(from.world,to.world);if(d>(kind==='rope'?18:kind==='strap'?2:.3))fail('ALIGN');
      if((kind==='deck'||kind==='ferry-lock')&&Object.values(s.links).some(l=>!l.broken&&((l.fromId===a.fromId&&l.fromSocket===a.fromSocket)||(l.toId===a.toId&&l.toSocket===a.toSocket))))fail('SOCKET_OCCUPIED');
      if(a.itemId){const i=s.inventory[a.itemId];if(!i||!['stored','world'].includes(i.state))fail('NO_ITEM');checkReach(w,pid,i.state==='stored'?'equipment-crate':i.bodyId??i.id);}
      if(kind==='strap'&&!strapPathClear(w,a.fromId,from,a.toId,to,a.itemId!,c.bodyId))fail('STRAP_BLOCKED');
      if(kind==='rope'&&!existing&&!ropePathClear(w,a.fromId,from,a.toId,to))fail('ROPE_BLOCKED');
      if(existing)w.reattachRope(existing,a.toId,a.toSocket);else{const link=w.addLink(kind,a.fromId,a.fromSocket,a.toId,a.toSocket,a.itemId??null);if(kind==='rope')c.controlling=link.id;}
      w.emit('attached',a.fromId,pid);w.emit('attached',a.toId,pid);
      if(w.map.id==='tutorial'&&s.tutorial.step===3&&a.itemId&&s.tutorial.flags[`removed:${a.itemId}`]&&((a.fromId==='cargo-2'&&a.toId==='truck')||(a.toId==='cargo-2'&&a.fromId==='truck')))s.tutorial.flags[`secured:${a.itemId}`]=1;
    }else if(a.type==='detach'){
      const link=s.links[a.connectionId];if(!link||link.broken)fail('NOT_FOUND');const r=w.canReach(pid,link.fromId,link.fromSocket);if(!r.ok)checkReach(w,pid,link.toId,link.toSocket);w.detachLink(a.connectionId);
    }else if(a.type==='anchor'){
      const e=s.entities[a.itemId];checkReach(w,pid,a.itemId);const ground=w.ground(w.body(a.itemId).translation(),2,a.itemId);if(!ground||!['soil','mud'].includes(ground.material)||ground.normal.y<Math.cos(25*Math.PI/180))fail('ANCHOR_MATERIAL');
      for(const id of heldBy(w,a.itemId))s.characters[id].holding=null;e.anchored=true;e.fixed=true;e.anchorLimit=ground.material==='mud'?11000:22000;w.body(a.itemId).setBodyType(RAPIER.RigidBodyType.Fixed,true);w.emit('anchor-installed',a.itemId,pid);
    }else if(a.type==='extract'){
      const e=s.entities[a.itemId];checkReach(w,pid,a.itemId);if(Object.values(s.links).some(l=>!l.broken&&(l.fromId===a.itemId||l.toId===a.itemId)))fail('ATTACHED');e.anchored=false;e.fixed=false;w.body(a.itemId).setBodyType(RAPIER.RigidBodyType.Dynamic,true);w.emit('anchor-extracted',a.itemId,pid);
    }else if(a.type==='repair'){
      const item=s.inventory[a.itemId!];if(!item||item.kind!=='repair'||!['stored','world'].includes(item.state))fail('NO_ITEM');if(item.state==='stored')checkReach(w,pid,'equipment-crate');else checkReach(w,pid,item.id);const link=s.links[a.targetId];
      if(link){checkReach(w,pid,link.fromId,link.fromSocket);if(!link.broken)fail('ALREADY_FULL');w.repairRope(link);w.emit('rope-repaired',link.fromId,pid);}
      else if(a.targetId==='lift-platform'){
        const lift=s.machinery.lift;if(!lift?.cableBroken)fail('ALREADY_FULL');checkReach(w,pid,a.targetId);if(length(w.body(a.targetId).linvel())>.2)fail('MOVING');lift.cableBroken=false;lift.catchHeight=null;lift.targetHeight=w.body('lift-platform').translation().y;(w.physics.impulseJoints.get(lift.guideJoint)as RAPIER.PrismaticImpulseJoint).setLimits(0,6);w.emit('repaired',a.targetId,pid);
      }else{
        checkReach(w,pid,'truck');if(length(w.body('truck').linvel())>.2)fail('MOVING');const e=s.entities.truck;if((e.integrity??100)>=100)fail('ALREADY_FULL');e.integrity=Math.min(100,(e.integrity??0)+25);w.emit('repaired','truck',pid,25);
      }
      if(item.bodyId&&s.entities[item.bodyId]?.active)w.removeBody(item.bodyId);item.state='destroyed';delete item.bodyId;w.updateMasses();
    }else if(a.type==='install-drive'){
      itemWorld(w,a.itemId,'drive');checkReach(w,pid,a.targetId,'drive');const target=w.socket(a.targetId,'drive')!,drive=w.socket(a.itemId,'drive')!;const body=w.body(a.itemId),targetBody=w.body(a.targetId);
      const qa=body.rotation(),qb=targetBody.rotation(),alignment=Math.abs(qa.x*qb.x+qa.y*qb.y+qa.z*qb.z+qa.w*qb.w);
      if(distance(target.world,drive.world)>.035||length(sub(w.pointVelocity(body,drive.world),w.pointVelocity(targetBody,target.world)))>.2||alignment<.99875)fail('ALIGN');
      const joint=w.physics.createImpulseJoint(RAPIER.JointData.fixed(target.local,Q(),drive.local,Q()),targetBody,body,true);joint.setContactsEnabled(false);
      const e=s.entities[a.itemId];e.sockets.forEach(socket=>socket.occupiedBy=a.targetId);s.inventory[a.itemId].state='attached';
      if(a.targetId==='ferry-deck')s.machinery.ferry!.driveId=a.itemId;else{s.machinery.lift!.driveId=a.itemId;s.machinery.lift!.driveJoint=joint.handle;}
      s.links[`drive-${a.itemId}`]={id:`drive-${a.itemId}`,kind:'ferry-lock',fromId:a.targetId,fromSocket:'drive',toId:a.itemId,toSocket:'drive',itemId:null,jointHandles:[joint.handle],length:distance(target.world,drive.world),limit:50000,tension:0,overload:0,broken:false,lastDistance:0,effectiveMass:40};w.emit('drive-installed',a.itemId,pid);
    }else if(a.type==='remove-drive'){
      const driveId=a.targetId==='ferry-deck'?s.machinery.ferry?.driveId:s.machinery.lift?.driveId;if(!driveId)fail('NO_DRIVE');checkReach(w,pid,a.targetId,'drive');w.detachLink(`drive-${driveId}`);s.inventory[driveId].state='world';s.inventory[driveId].bodyId=driveId;for(const socket of s.entities[driveId].sockets)delete socket.occupiedBy;
      if(a.targetId==='ferry-deck')s.machinery.ferry!.driveId=null;else s.machinery.lift!.driveId=null;w.emit('drive-removed',driveId,pid);
    }else if(a.type==='rescue')w.beginRescue(pid);
  }catch(error){w.emit('operation-failed',operation.targetId,pid,undefined,MESSAGES[error instanceof Error?error.message:'INVALID_ACTION']??MESSAGES.INVALID_ACTION);}
}

export function interactionsFor(w:TyagaWorld,pid:string):InteractionView[]{
  const c=w.state.characters[pid];if(!c)return[];const result:InteractionView[]=[];
  const push=(id:string,ru:string,en:string,action:TyagaAction,targetId?:string,condition='OK',socket?:string)=>{
    const reach=targetId&&w.state.entities[targetId]?.active?w.canReach(pid,targetId,socket):{ok:true,distance:0,code:'OK'};
    let code=condition==='OK'?reach.code:condition;
    if(w.state.operations[pid]&&!['release','cancel'].includes(action.type))code='BUSY';
    if(c.controlling&&!['release','brake'].includes(action.type))code='BUSY';
    if(c.holding&&['grab','unpack','operate','pack'].includes(action.type))code='HANDS_BUSY';
    if(reach.distance>4&&condition!=='BUSY')return;
    result.push({id,label:{ru,en},action,enabled:code==='OK',...(code!=='OK'?{reason:MESSAGES[code]??MESSAGES.INVALID_ACTION}:{}),...(targetId?{targetId}:{}),distance:reach.distance});
  };
  if(c.controlling||c.holding){push('release','Отпустить','Release',{type:'release'},c.holding?.itemId);if(c.holding){push('rotate-left','Повернуть влево','Rotate left',{type:'rotate',direction:1},c.holding.itemId);push('rotate-right','Повернуть вправо','Rotate right',{type:'rotate',direction:-1},c.holding.itemId);}}
  for(const e of Object.values(w.state.entities))if(e.active&&e.kind!=='character'&&e.kind!=='rope-segment'){
    if(e.id==='truck'&&!c.controlling&&!c.holding){
      const socket=w.closestSocket('truck',add(w.body(c.bodyId).translation(),V(0,.25,0)),'cab');push('drive','Сесть за руль','Drive',{type:'operate',targetId:'truck'},'truck',w.state.truck.driver?'BUSY':length(w.body('truck').linvel())>1?'MOVING':'OK',socket?.id);
      push('rear-brake','Держать тормоз','Hold brake',{type:'brake',enabled:true},'truck','OK','rear-brake');
    }else if(e.kind==='crate'){
      for(const kind of ['deck','beam','winch','anchor','strap','jack','repair']as const){const i=Object.values(w.state.inventory).find(i=>i.kind===kind&&i.state==='stored');if(i)push(`unpack-${kind}`,`Достать: ${BODY[kind].name.ru}`,`Unpack: ${BODY[kind].name.en}`,{type:'unpack',itemId:i.id},e.id);}
    }else if(e.kind==='ferry-deck'){
      push('ferry-operate','Управлять паромом','Steer ferry',{type:'operate',targetId:e.id},e.id,!w.state.machinery.ferry?.driveId?'NO_DRIVE':!w.state.machinery.ferry.launched?'NO_SUPPORT':w.state.machinery.ferry.operator?'BUSY':'OK','control');
      if(!w.state.machinery.ferry?.launched)push('ferry-launch','Опустить паром','Launch ferry',{type:'launch-ferry'},e.id,Object.values(w.state.links).filter(l=>l.kind==='ferry-lock'&&!l.broken&&l.fromSocket.startsWith('lock-')).length!==4?'FERRY_LOCKS':!w.state.machinery.ferry?.driveId?'NO_DRIVE':'OK','control');
    }else if(e.kind==='lift'||['lift-transmission','lift-lower-control'].includes(e.id))push(`operate-${e.id}`,'Управлять подъёмником','Operate lift',{type:'operate',targetId:e.id},e.id,!w.state.machinery.lift?.driveId?'NO_DRIVE':w.state.machinery.lift.operator?'BUSY':!Object.values(w.state.machinery.lift.barriers).every(Boolean)?'BARRIER':w.state.machinery.lift.cableBroken?'NO_REPAIR':'OK','control');
    else if(e.kind==='barrier')push(`barrier-${e.id}`,w.state.machinery.lift?.barriers[e.id]?'Открыть барьер':'Закрыть барьер',w.state.machinery.lift?.barriers[e.id]?'Open barrier':'Close barrier',{type:'barrier',targetId:e.id,closed:!w.state.machinery.lift?.barriers[e.id]},e.id,'OK','control');
    if(!e.fixed&&!['truck','character','lift','barrier'].includes(e.kind)){
      const handle=w.closestSocket(e.id,w.body(c.bodyId).translation(),'handle');if(handle)push(`grab-${e.id}`,`Взять: ${BODY[e.kind].name.ru}`,`Grab: ${BODY[e.kind].name.en}`,{type:'grab',itemId:e.id,handleId:handle.id},e.id,handle.occupiedBy?'HANDLE_BUSY':'OK',handle.id);
      if(e.kind==='deck'&&e.folded)push(`unfold-${e.id}`,'Разложить настил','Unfold deck',{type:'unfold',itemId:e.id},e.id);
      if(e.kind==='anchor')push(`anchor-${e.id}`,'Установить якорь','Install anchor',{type:'anchor',itemId:e.id},e.id);
      if(e.kind==='jack'&&w.state.machinery.jacks[e.id])push(`jack-${e.id}`,'Работать домкратом','Operate jack',{type:'operate',targetId:e.id},e.id,'OK','control');
    }else if(e.kind==='anchor'&&e.anchored)push(`extract-${e.id}`,'Извлечь якорь','Extract anchor',{type:'extract',itemId:e.id},e.id);
  }
  const storedRepair=Object.values(w.state.inventory).find(item=>item.kind==='repair'&&item.state==='stored');
  const nearbyRepair=Object.values(w.state.inventory).find(item=>item.kind==='repair'&&item.state==='world'&&w.canReach(pid,item.id).ok);
  const repairItem=storedRepair&&w.canReach(pid,'equipment-crate').ok?storedRepair:nearbyRepair??storedRepair;
  const repairResourceReason=!repairItem?'NO_ITEM':repairItem.state==='stored'&&!w.canReach(pid,'equipment-crate').ok?'TOO_FAR':'OK';
  const trunkReach=w.canReach(pid,'equipment-crate');
  for(const item of Object.values(w.state.inventory)){
    if(item.state!=='world'||!w.state.entities[item.bodyId??item.id]?.active)continue;
    const id=item.bodyId??item.id,body=w.body(id);
    const attached=Object.values(w.state.links).some(l=>!l.broken&&!l.detached&&(l.fromId===id||l.toId===id));
    push(`pack-${id}`,`Упаковать: ${item.name.ru}`,`Pack: ${item.name.en}`,{type:'pack',itemId:item.id},id,!trunkReach.ok?trunkReach.code:heldBy(w,id).length?'HANDS_BUSY':attached?'ATTACHED':length(body.linvel())>.1?'MOVING':w.hasSupportedLoad(id)?'SUPPORTED_LOAD':'OK');
    if(item.kind==='jack'){
      const ground=w.ground(body.translation(),1,id);
      for(const target of Object.values(w.state.entities))if(target.active&&!target.fixed&&target.id!==id&&!['character','rope-segment','hook','jack','anchor','strap','repair'].includes(target.kind)&&distance(body.translation(),w.body(target.id).translation())<6){
        const tb=w.body(target.id),local=localPoint(tb.translation(),tb.rotation(),body.translation());
        const reason=!ground?'NO_SUPPORT':ground.normal.y<Math.cos(12*Math.PI/180)?'SLOPE':Math.abs(local.x)>target.size.x/2+.3||Math.abs(local.z)>target.size.z/2+.3?'ALIGN':'OK';
        push(`jack-install-${id}-${target.id}`,`Поднять: ${BODY[target.kind].name.ru}`,`Lift: ${BODY[target.kind].name.en}`,{type:'jack',itemId:item.id,targetId:target.id},id,reason);
      }
    }
    if(item.kind==='drive')for(const target of ['ferry-deck','lift-transmission'])if(w.state.entities[target]?.active){
      const socket=w.socket(target,'drive')!,own=w.socket(id,'drive')!;const reach=w.canReach(pid,target,'drive');
      const occupied=target==='ferry-deck'?w.state.machinery.ferry?.driveId:w.state.machinery.lift?.driveId;
      const reason=occupied?'BUSY':!reach.ok?reach.code:distance(own.world,socket.world)>.3?'ALIGN':'OK';
      push(`install-drive-${id}-${target}`,target==='ferry-deck'?'Привод на паром':'Привод на подъёмник',target==='ferry-deck'?'Install ferry drive':'Install lift drive',{type:'install-drive',itemId:item.id,targetId:target},id,reason,'handle-0');
    }
  }
  push('repair-truck','Ремонт машины','Repair truck',{type:'repair',targetId:'truck',...(repairItem?{itemId:repairItem.id}:{})},'truck',(w.state.entities.truck.integrity??100)>=100?'ALREADY_FULL':length(w.body('truck').linvel())>.2?'MOVING':repairResourceReason);
  if(w.state.machinery.lift?.cableBroken)push('repair-lift','Восстановить подъёмник','Repair lift',{type:'repair',targetId:'lift-platform',...(repairItem?{itemId:repairItem.id}:{})},'lift-platform',repairResourceReason);
  for(const link of Object.values(w.state.links))if(link.kind==='rope'&&link.broken)push(`repair-${link.id}`,'Восстановить трос','Repair cable',{type:'repair',targetId:link.id,...(repairItem?{itemId:repairItem.id}:{})},link.fromId,link.collarId&&distance(w.body(link.collarId).translation(),w.socket(link.fromId,link.fromSocket)!.world)>.3?'ALIGN':repairResourceReason,link.fromSocket);
  if(w.state.machinery.ferry?.driveId)push('remove-ferry-drive','Снять привод','Remove drive',{type:'remove-drive',targetId:'ferry-deck'},'ferry-deck',w.state.machinery.ferry.operator?'MOVING':'OK','drive');
  if(w.state.machinery.lift?.driveId)push('remove-lift-drive','Снять привод','Remove drive',{type:'remove-drive',targetId:'lift-transmission'},'lift-transmission',w.state.machinery.lift.operator?'MOVING':'OK','drive');
  for(const l of Object.values(w.state.links))if(!l.broken&&l.kind==='rope')push(`winch-${l.id}`,'Работать лебёдкой','Operate winch',{type:'operate',targetId:l.id},l.fromId,'OK',l.fromSocket);
  return result.sort((a,b)=>Number(b.enabled)-Number(a.enabled)||(a.distance??0)-(b.distance??0));
}
