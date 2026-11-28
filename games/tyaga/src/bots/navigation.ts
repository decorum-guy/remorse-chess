import { add, distance, mix, V } from '../core/math';
import { BODY } from '../core/config';
import type { TyagaMap, TyagaView, Vec3 } from '../core/types';

export interface NavigationMemory { path?:Vec3[];pathGoal?:Vec3;pathUpdatedAt?:number;blockedFor?:number }
interface Node {id:string;position:Vec3;edges:{to:string;cost:number;jump:boolean}[]}
const cache=new WeakMap<TyagaMap,Map<string,Node>>();
function graph(map:TyagaMap):Map<string,Node>{
 const cached=cache.get(map);if(cached)return cached;
 const result=new Map<string,Node>(map.footGraph.nodes.map(n=>[n.id,{...n,edges:[]}]));
 for(const [ei,e]of map.footGraph.edges.entries()){
  const a=result.get(e.from),b=result.get(e.to);if(!a||!b)continue;
  const count=e.kind==='jump'?1:Math.max(1,Math.ceil(distance(a.position,b.position)/3));let previous=a;
  for(let i=1;i<=count;i++){
   const node=i===count?b:{id:`sub:${ei}:${i}`,position:mix(a.position,b.position,i/count),edges:[]};
   if(i<count)result.set(node.id,node);
   const cost=distance(previous.position,node.position)+(e.kind==='jump'?1:0);
   previous.edges.push({to:node.id,cost,jump:e.kind==='jump'});
   if(e.bidirectional!==false)node.edges.push({to:previous.id,cost,jump:e.kind==='jump'});
   previous=node;
  }
 }
 cache.set(map,result);return result;
}
function groundPath(view:TyagaView,a:Vec3,b:Vec3,ground:(v:TyagaView,p:Vec3)=>number|null):boolean{
 const count=Math.max(1,Math.ceil(Math.hypot(a.x-b.x,a.z-b.z)/.8));let previous:number|null=null;
 for(let i=0;i<=count;i++){
  const p=mix(a,b,i/count),h=ground(view,add(p,V(0,1,0)));
  if(h===null||previous!==null&&Math.abs(h-previous)>.8)return false;
  // A walkable riverbed is not a safe foot route. Plan against the published
  // high-water mark so a helper does not enter a crossing that floods while
  // following a moving truck. The existing raised footpath remains usable.
  if(view.map.waterVolumes.some(w=>p.x>w.min.x&&p.x<w.max.x&&p.z>w.min.z&&p.z<w.max.z&&h+BODY.character.size.y/2<w.baseLevel+w.amplitude+.15))return false;
  previous=h;
 }
 return true;
}
/** Navigation observes only published geometry and emits foot waypoints. */
export function footWaypoint(view:TyagaView,actor:Vec3,goal:Vec3,memory:NavigationMemory,now:number,ground:(v:TyagaView,p:Vec3)=>number|null):Vec3{
 if(!memory.pathGoal||distance(goal,memory.pathGoal)>2||now-(memory.pathUpdatedAt??-100)>1||memory.path===undefined){
  memory.pathUpdatedAt=now;memory.pathGoal={...goal};
  if(groundPath(view,actor,goal,ground)){memory.path=[{...goal}];}
  else{
   const nodes=graph(view.map),sorted=[...nodes.values()];
   const starts=sorted.map(n=>({n,d:distance(n.position,actor)})).sort((a,b)=>a.d-b.d).slice(0,12).filter(x=>x.d<12&&groundPath(view,actor,x.n.position,ground));
   const ends=new Map(sorted.map(n=>({n,d:distance(n.position,goal)})).sort((a,b)=>a.d-b.d).slice(0,12).filter(x=>x.d<12&&groundPath(view,x.n.position,goal,ground)).map(x=>[x.n.id,x.d]));
   const costs=new Map<string,number>(),previous=new Map<string,string>(),open=new Set<string>();
   for(const start of starts){costs.set(start.n.id,start.d);open.add(start.n.id);}
   let found:string|undefined;
   while(open.size&&ends.size){
    let next:string|undefined,best=Infinity;for(const id of open){const score=(costs.get(id)??Infinity)+distance(nodes.get(id)!.position,goal);if(score<best){best=score;next=id;}}
    if(!next)break;open.delete(next);if(ends.has(next)){found=next;break;}
    const node=nodes.get(next)!;
    for(const e of node.edges){const target=nodes.get(e.to)!;if(e.jump){if(ground(view,add(target.position,V(0,1,0)))===null)continue;}else if(!groundPath(view,node.position,target.position,ground))continue;
     const candidate=(costs.get(next)??0)+e.cost;if(candidate<(costs.get(e.to)??Infinity)){costs.set(e.to,candidate);previous.set(e.to,next);open.add(e.to);}
    }
   }
   const path:Vec3[]=[];
   if(found){let current:string|undefined=found;while(current){path.unshift({...nodes.get(current)!.position});current=previous.get(current);}path.push({...goal});}
   memory.path=path;
  }
 }
 const path=memory.path??[];
 while(path.length>1&&Math.hypot(path[0].x-actor.x,path[0].z-actor.z)<.65)path.shift();
 // No route means wait on the current support. A direct fallback here used
 // to walk straight into the same water or gap that the planner rejected.
 return path[0]??actor;
}
