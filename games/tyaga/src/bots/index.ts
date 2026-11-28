import { footWaypoint } from './navigation';
import type { NavigationMemory } from './navigation';
import { NEUTRAL_INPUT } from '../core/config';
import { add, angleDifference, clamp, conjugate, cross, distance, dot, localPoint, mul, norm, rotate, sub, V, yaw } from '../core/math';
import type { EntityView, Quat, Surface, TyagaAction, TyagaInput, TyagaView, Vec3 } from '../core/types';

export interface BotMemory extends NavigationMemory { nextActionAt:number;lastPosition:Vec3;stuckFor:number;lastJumpAt:number; input?:TyagaInput;carryOffset?:Vec3;carryObject?:string;carryWith?:string;carryHeightDifference?:number }
export interface BotDecision { input:TyagaInput;action?:TyagaAction;status?:'working'|'holding'|'completed'|'needs-help';message?:{ru:string;en:string} }
const dotHorizontal=(a:Vec3,b:Vec3)=>a.x*b.x+a.z*b.z;
function topAt(position:Vec3,center:Vec3,rotation:Quat,size:Vec3):number|null{
  const origin=localPoint(center,rotation,add(position,V(0,10,0))),direction=rotate(conjugate(rotation),V(0,-1,0));
  if(Math.abs(direction.y)<.01)return null;const t=(size.y/2-origin.y)/direction.y;if(t<0)return null;const hit=add(origin,mul(direction,t));
  if(Math.abs(hit.x)>size.x/2||Math.abs(hit.z)>size.z/2)return null;return position.y+10-t;
}
function meshTopAt(position:Vec3,surface:Surface):number|null{
  const mesh=surface.mesh!;const origin=localPoint(surface.position,surface.rotation,add(position,V(0,10,0))),direction=rotate(conjugate(surface.rotation),V(0,-1,0));
  if(Math.abs(direction.x)<1e-8&&Math.abs(origin.x)>surface.size.x/2||Math.abs(direction.z)<1e-8&&Math.abs(origin.z)>surface.size.z/2)return null;
  const vertex=(i:number)=>V(mesh.vertices[i*3],mesh.vertices[i*3+1],mesh.vertices[i*3+2]);let nearest=Infinity;
  for(let i=0;i<mesh.indices.length;i+=3){
    const a=vertex(mesh.indices[i]),e1=sub(vertex(mesh.indices[i+1]),a),e2=sub(vertex(mesh.indices[i+2]),a),h=cross(direction,e2),det=dot(e1,h);
    // Back-face rejection also excludes the real underside of the terrain.
    if(det<1e-8)continue;const from=sub(origin,a),u=dot(from,h)/det;if(u<0||u>1)continue;
    const q=cross(from,e1),v=dot(direction,q)/det;if(v<0||u+v>1)continue;
    const t=dot(e2,q)/det;if(t>=0&&t<nearest)nearest=t;
  }
  return Number.isFinite(nearest)?position.y+10-nearest:null;
}
export function observedGround(view:TyagaView,point:Vec3):number|null{
  let y:number|null=null;
  for(const s of view.map.surfaces){const h=s.mesh?meshTopAt(point,s):topAt(point,s.position,s.rotation,s.size);if(h!==null&&h<point.y+4&&(y===null||h>y))y=h;}
  for(const e of view.entities)if(['deck','ferry-deck','lift','ramp'].includes(e.kind)){const h=topAt(point,e.position,e.rotation,e.size);if(h!==null&&h<point.y+4&&(y===null||h>y))y=h;}
  return y;
}
function avoidingTarget(view:TyagaView,actor:EntityView,target:Vec3):Vec3{
  const me=view.participants.find(p=>p.entityId===actor.id);
  const obstacles=view.entities.filter(e=>e.id!==me?.holding&&distance(e.position,actor.position)<22&&
    (['truck','generator-large','pump-large','mast','block'].includes(e.kind)||e.id===me?.task?.targetId&&['carry','hold'].includes(me?.task?.kind??''))&&
    actor.position.y<e.position.y+e.size.y/2+1).map(e=>{
      const x=rotate(e.rotation,V(e.size.x/2,0,0)),y=rotate(e.rotation,V(0,e.size.y/2,0)),z=rotate(e.rotation,V(0,0,e.size.z/2));
      const hx=Math.abs(x.x)+Math.abs(y.x)+Math.abs(z.x)+.36,hz=Math.abs(x.z)+Math.abs(y.z)+Math.abs(z.z)+.36;
      return{minX:e.position.x-hx,maxX:e.position.x+hx,minZ:e.position.z-hz,maxZ:e.position.z+hz};
    });
  const inside=(p:Vec3,e:typeof obstacles[number])=>p.x>e.minX+.01&&p.x<e.maxX-.01&&p.z>e.minZ+.01&&p.z<e.maxZ-.01;
  const contained=obstacles.find(e=>inside(actor.position,e));
  if(contained){
    const p=actor.position,e=contained;
    return[V(e.minX-.1,p.y,p.z),V(e.maxX+.1,p.y,p.z),V(p.x,p.y,e.minZ-.1),V(p.x,p.y,e.maxZ+.1)].sort((a,b)=>distance(a,p)-distance(b,p))[0];
  }
  const clear=(from:Vec3,to:Vec3)=>obstacles.every(e=>{
    const d=sub(to,from);let lo=0,hi=1;
    for(const [axis,min,max]of [['x',e.minX+.01,e.maxX-.01],['z',e.minZ+.01,e.maxZ-.01]]as const){
      if(Math.abs(d[axis])<1e-7){if(from[axis]<=min||from[axis]>=max)return true;}
      else{const t1=(min-from[axis])/d[axis],t2=(max-from[axis])/d[axis];lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));}
    }
    return lo>=hi||hi<=0||lo>=1;
  });
  if(clear(actor.position,target))return target;
  const corners=obstacles.flatMap(e=>[e.minX,e.maxX].flatMap(x=>[e.minZ,e.maxZ].map(z=>V(x,actor.position.y,z)))).filter(p=>!obstacles.some(e=>inside(p,e)));
  const points=[actor.position,{...target,y:actor.position.y},...corners],cost=points.map(()=>Infinity),previous=points.map(()=>-1),visited=new Set<number>();cost[0]=0;
  for(let n=0;n<points.length;n++){
    let current=-1;for(let i=0;i<points.length;i++)if(!visited.has(i)&&(current<0||cost[i]<cost[current]))current=i;
    if(current<0||!Number.isFinite(cost[current]))break;visited.add(current);
    for(let i=0;i<points.length;i++)if(!visited.has(i)&&clear(points[current],points[i])){const candidate=cost[current]+distance(points[current],points[i]);if(candidate<cost[i]){cost[i]=candidate;previous[i]=current;}}
  }
  if(previous[1]<0)return target;const path=[1];while(previous[path[0]]>0)path.unshift(previous[path[0]]);
  // Advance around a corner before Coulomb friction arrests a vanishing
  // proportional input. The 6 cm hull margin still exceeds this look-ahead.
  if(path.length>1&&Math.hypot(points[path[0]].x-actor.position.x,points[path[0]].z-actor.position.z)<.05)path.shift();
  return points[path[0]];
}
function walkTo(view:TyagaView,actor:EntityView,target:Vec3,stop=.8,allowGap=false):TyagaInput{
  const detour=avoidingTarget(view,actor,target);if(detour!==target)stop=.005;target=detour;
  const delta=sub(target,actor.position),horizontal=Math.hypot(delta.x,delta.z);if(horizontal<stop)return{...NEUTRAL_INPUT};
  const direction=norm(V(delta.x,0,delta.z));
  const step=add(actor.position,mul(direction,.65));const ground=observedGround(view,step);
  if(!allowGap&&(ground===null||ground<actor.position.y-2.8))return{...NEUTRAL_INPUT};
  const approachSpeed=clamp(horizontal/.65,0,1);
  return{...NEUTRAL_INPUT,moveX:direction.x*approachSpeed,moveZ:direction.z*approachSpeed,run:horizontal>6};
}
function routeTarget(view:TyagaView,truck:EntityView,goal:Vec3):Vec3{
  let best:{score:number;points:Vec3[];start:number;end:number}|null=null;
  for(const route of view.map.routes){
    let start=0,end=0,sd=Infinity,ed=Infinity;
    route.points.forEach((p,i)=>{const d=distance(p,truck.position);if(d<sd){sd=d;start=i;}const g=distance(p,goal);if(g<ed){ed=g;end=i;}});
    if(end<start)continue;let cost=sd+ed;for(let i=start+1;i<=end;i++)cost+=distance(route.points[i],route.points[i-1]);
    // A broken bridge cannot become a planned invisible shortcut.
    let blocked=false;for(let i=start;i<end;i++){const a=route.points[i],b=route.points[i+1];const count=Math.ceil(distance(a,b));for(let n=0;n<=count;n++){const p=add(a,mul(sub(b,a),n/(count||1)));const ground=observedGround(view,add(p,V(0,1,0)));if(ground===null||ground<p.y-1.2){blocked=true;break;}}if(blocked)break;}
    if(blocked)cost+=10000;
    if(!best||cost<best.score)best={score:cost,points:route.points,start,end};
  }
  if(!best||best.score>=10000)return goal;
  let i=best.start;while(i<best.end&&Math.hypot(best.points[i].x-truck.position.x,best.points[i].z-truck.position.z)<4)i++;
  return i===best.end&&distance(best.points[i],goal)<3?goal:best.points[i];
}

/** A bot receives exactly the same public world view and emits ordinary input/actions. */
export function chooseBotAction(view:TyagaView,memory:BotMemory,now:number):BotDecision{
  const me=view.participants.find(p=>p.participantId===view.participantId)!;const actor=view.entities.find(e=>e.id===me.entityId)!;const truck=view.entities.find(e=>e.id==='truck')!;
  const output:BotDecision={input:{...NEUTRAL_INPUT}};
  if(!actor||view.phase!=='running'||me.rescueIn!==undefined)return output;
  if(view.operations.some(o=>o.participantId===me.participantId))return output;
  const act=(action:TyagaAction):BotDecision=>{if(now>=memory.nextActionAt){memory.nextActionAt=now+.35;output.action=action;}return output;};
  const walk=(goal:Vec3,stop=.8):BotDecision=>{
    const target=footWaypoint(view,actor.position,goal,memory,now,observedGround);
    const delta=sub(target,actor.position),direction=norm(V(delta.x,0,delta.z));
    const ahead=add(actor.position,mul(direction,.7)),ground=observedGround(view,ahead),landing=observedGround(view,target);
    const horizontal=Math.hypot(delta.x,delta.z),airborne=actor.animation==='jump'||actor.animation==='fall';
    const jumpGap=ground===null&&landing!==null&&horizontal<3&&horizontal>.4;
    const finalWaypoint=Math.hypot(target.x-goal.x,target.z-goal.z)<.05;
    output.input=walkTo(view,actor,target,finalWaypoint?stop:.4,airborne||jumpGap);
    const displacement=distance(actor.position,memory.lastPosition);memory.stuckFor=displacement<.015&&Math.hypot(output.input.moveX,output.input.moveZ)>.1?memory.stuckFor+.1:0;memory.lastPosition={...actor.position};
    if(!airborne&&(jumpGap||memory.stuckFor>1||ground!==null&&ground>actor.position.y-.55)&&now-memory.lastJumpAt>1.5){memory.lastJumpAt=now;memory.stuckFor=0;output.input.run=true;return act({type:'jump'});}
    return output;
  };
  const task=me.task??{kind:'follow' as const,status:'following'};
  if(task.status!=='accepted'&&task.status!=='following'&&task.status!=='working'&&task.status!=='holding')return output;
  const target=task.targetId?view.entities.find(e=>e.id===task.targetId):undefined;
  if(task.kind==='drive'){
    const goal=task.point??view.map.finish.position;
    if(me.controlling!=='truck'){
      if(me.controlling||me.holding)return act({type:'release'});
      const cab=truck.sockets.filter(s=>s.role==='cab'&&s.id!=='seat').sort((a,b)=>distance(a.world,actor.position)-distance(b.world,actor.position))[0];
      const ready=view.interactions.find(i=>i.id==='drive'&&i.enabled);if(ready)return act(ready.action);
      return walk(add(cab.world,rotate(truck.rotation,V(0,0,cab.local.z>0?.5:-.5))),.4);
    }
    if(view.truck.brake)return act({type:'brake',enabled:false});
    if(Math.hypot(truck.position.x-goal.x,truck.position.z-goal.z)<2.2&&Math.abs(truck.position.y-goal.y)<3){output.input.brake=true;if(Math.abs(view.truck.speed)<.12){output.status='completed';output.message={ru:'Машина у метки. Тормоз включён.',en:'Truck at the marker. Parking brake is on.'};return act({type:'release'});}return output;}
    const waypoint=routeTarget(view,truck,goal),delta=sub(waypoint,truck.position);const desired=-Math.atan2(delta.z,delta.x);const error=angleDifference(desired,yaw(truck.rotation));
    const forward=rotate(truck.rotation,V(1,0,0));const look=add(truck.position,mul(forward,4));const ground=observedGround(view,look);
    if(ground===null||ground<truck.position.y-2.1){output.input.brake=true;return output;}
    const safeSpeed=Math.abs(error)>.6?.8:Math.abs(error)>.25?1.6:2.5;
    output.input.steer=clamp(error*1.8,-1,1);output.input.throttle=view.truck.speed<safeSpeed?clamp(safeSpeed-view.truck.speed,.12,1):0;output.input.brake=view.truck.speed>safeSpeed+.2;
    return output;
  }
  if(task.kind==='carry'||task.kind==='hold'){
    if(!target)return output;
    if(me.holding===target.id){
      if(task.kind==='hold')return output;
      const partner=view.participants.find(p=>p.participantId!==me.participantId&&p.holding===target.id);
      if(partner){const partnerActor=view.entities.find(e=>e.id===partner.entityId)!;const ownHandle=target.sockets.find(s=>s.occupiedBy===me.participantId);const otherHandle=target.sockets.find(s=>s.occupiedBy===partner.participantId);
        if(ownHandle&&otherHandle){
          if(memory.carryWith!==partner.participantId||memory.carryObject!==target.id||!memory.carryOffset){memory.carryWith=partner.participantId;memory.carryObject=target.id;memory.carryOffset=V(actor.position.x-partnerActor.position.x,0,actor.position.z-partnerActor.position.z);memory.carryHeightDifference=(me.gripHeight??0)-(partner.gripHeight??0)+actor.position.y-partnerActor.position.y;}
          // Preserve the formation chosen by the two real grasps. Deriving
          // this offset from the swinging cargo fed its rotation back into
          // walking and made a stationary pair circle around the object.
          const desired=add(partnerActor.position,memory.carryOffset);const delta=sub(desired,actor.position),speed=target.mass>55?1.3:2;
          const x=partnerActor.velocity.x/speed+delta.x*.8,z=partnerActor.velocity.z/speed+delta.z*.8,scale=Math.max(1,Math.hypot(x,z));
          const heightError=(partner.gripHeight??0)+(memory.carryHeightDifference??0)+partnerActor.position.y-actor.position.y-(me.gripHeight??0);
          output.input.moveX=x/scale;output.input.moveZ=z/scale;output.input.tool=Math.abs(heightError)>.02?clamp(heightError*16,-1,1):0;output.status='working';return output;
        }
      }
      return output;
    }
    delete memory.carryWith;delete memory.carryOffset;delete memory.carryObject;delete memory.carryHeightDifference;
    const handle=target.sockets.filter(s=>s.role==='handle'&&!s.occupiedBy).sort((a,b)=>distance(a.world,actor.position)-distance(b.world,actor.position))[0];if(!handle)return output;
    const outward=norm(V(handle.world.x-target.position.x,0,handle.world.z-target.position.z)),approach=add(handle.world,mul(outward,.55));
    const ready=view.interactions.find(i=>i.targetId===target.id&&i.action.type==='grab'&&i.enabled);
    const offset=sub(actor.position,handle.world),outside=dotHorizontal(offset,outward)>.36,tangential=Math.abs(dotHorizontal(offset,V(outward.z,0,-outward.x)));
    if(ready&&outside&&tangential<.2&&actor.animation!=='jump'&&actor.animation!=='fall')return act({type:'grab',itemId:target.id,handleId:handle.id});
    return walk(approach,.18);
  }
  if(task.kind==='winch'){
    const link=view.connections.find(l=>!l.broken&&l.kind==='rope'&&(l.id===task.targetId||l.fromId===task.targetId));if(!link)return output;
    if(me.controlling===link.id){if(link.tension>(link.fromId==='truck'?12600:9000)||link.length<1.6){output.status=link.length<1.6?'completed':'needs-help';output.message=link.length<1.6?{ru:'Трос намотан.',en:'Cable reeled in.'}:{ru:'Высокая нагрузка. Остановил барабан.',en:'High load. I stopped the drum.'};return act({type:'release'});}output.input.tool=1;return output;}
    const source=view.entities.find(e=>e.id===link.fromId)!;const socket=source.sockets.find(s=>s.id===link.fromSocket)!;
    const ready=view.interactions.find(i=>i.id===`winch-${link.id}`&&i.enabled);if(ready)return act(ready.action);return walk(socket.world,.8);
  }
  if(task.kind==='secure'){
    const cargo=view.entities.filter(e=>e.required&&e.id!=='truck');const loose=cargo.find(e=>view.connections.filter(l=>!l.broken&&l.kind==='strap'&&(l.fromId===e.id||l.toId===e.id)).length<(e.id==='cargo-1'?4:2));
    if(!loose){output.status='completed';output.message={ru:'Грузы закреплены.',en:'The cargo is secured.'};return output;}
    const item=view.inventory.find(i=>i.kind==='strap'&&i.id===me.holding)??view.inventory.find(i=>i.kind==='strap'&&i.state==='world'&&!view.participants.some(p=>p.holding===i.id))??view.inventory.find(i=>i.kind==='strap'&&i.state==='stored');
    if(!item){output.status='needs-help';output.message={ru:'Нужен свободный ремень.',en:'I need a spare strap.'};return output;}
    if(item.state==='stored'){
      if(me.holding)return act({type:'release'});
      const unpack=view.interactions.find(i=>i.id==='unpack-strap');if(unpack?.enabled)return act({...unpack.action,itemId:item.id}as TyagaAction);
      const crate=view.entities.find(e=>e.kind==='crate')!,door=crate.sockets.filter(s=>s.role==='crate').sort((a,b)=>distance(a.world,actor.position)-distance(b.world,actor.position))[0];
      return walk(add(door.world,V(0,0,Math.sign(door.local.z)*.7)),.55);
    }
    const strap=view.entities.find(e=>e.id===(item.bodyId??item.id));if(!strap)return output;
    if(me.holding!==strap.id){if(me.holding)return act({type:'release'});const grab=view.interactions.find(i=>i.targetId===strap.id&&i.action.type==='grab'&&i.enabled);if(grab)return act(grab.action);return walk(strap.position,.65);}

    const socket=loose.sockets.filter(s=>s.role==='ring'&&s.id!=='top-ring'&&!view.connections.some(l=>!l.broken&&l.fromId===loose.id&&l.fromSocket===s.id)).sort((a,b)=>distance(a.world,actor.position)-distance(b.world,actor.position))[0];if(!socket)return output;
    const to=truck.sockets.filter(s=>s.role==='ring').sort((a,b)=>distance(a.world,socket.world)-distance(b.world,socket.world))[0];if(!to||distance(to.world,socket.world)>2)return output;
    if(distance(actor.position,socket.world)<1.6)return act({type:'attach',kind:'strap',fromId:loose.id,fromSocket:socket.id,toId:'truck',toSocket:to.id,itemId:item.id});return walk(add(socket.world,V(0,0,Math.sign(socket.world.z-truck.position.z)*.8)),.6);
  }
  // Autonomous helper follows from the ground. It neither claims a steering
  // wheel unasked nor approves a checkpoint on behalf of a human.
  if(me.controlling||me.holding)return act({type:'release'});
  let goal=add(truck.position,rotate(truck.rotation,V(-2.8+Math.floor(me.seatIndex/2)*1.8,0,me.seatIndex%2?1.7:-1.7)));
  const humans=view.participants.filter(p=>p.controller==='human'&&p.connected);const leader=humans.length===1?view.entities.find(e=>e.id===humans[0].entityId):undefined;
  if(leader&&distance(leader.position,truck.position)>10)goal=add(leader.position,V(-1.5,0,me.seatIndex%2?1:-1));
  return walk(goal,.65);
}
