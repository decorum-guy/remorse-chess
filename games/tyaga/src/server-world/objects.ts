import type { EntityKind, SocketView, Vec3 } from '../core/types';
import { V } from '../core/math';
export type LocalSocket = Omit<SocketView,'world'>;
const s=(id:string,local:Vec3,role:SocketView['role']):LocalSocket=>({id,local,role});
export function socketsFor(kind:EntityKind,size:Vec3):LocalSocket[]{
  if(kind==='truck')return [
    s('cab-left',V(2.45,.8,-1.35),'cab'),s('cab-right',V(2.45,.8,1.35),'cab'),s('seat',V(2.5,.65,0),'cab'),
    s('front-winch',V(3.2,-.08,0),'control'),s('rear-brake',V(-3.25,.25,0),'control'),
    ...[-2.2,-.8,.8,1.8].flatMap((x,i)=>[-1,1].map(z=>s(`ring-${i}-${z}`,V(x,.42,z*1.18),'ring'))),
    s('front-tow',V(3.2,-.1,0),'ring'),s('rear-tow',V(-3.2,-.1,0),'ring'),
  ];
  if(kind==='character'||kind==='rope-segment')return [];
  if(kind==='hook')return [s('handle-0',V(),'handle'),s('ring',V(),'ring')];
  if(kind==='ring')return [s('ring',V(),'ring')];
  if(kind==='crate')return [s('door-left',V(0,0,-size.z/2),'crate'),s('door-right',V(0,0,size.z/2),'crate'),s('ring-0',V(-size.x/2,0,-.8),'ring'),s('ring-1',V(size.x/2,0,.8),'ring')];
  if(kind==='deck')return [s('handle-0',V(0,.1,-size.z/2),'handle'),s('handle-1',V(0,.1,size.z/2),'handle'),...[-1,1].flatMap(x=>[-1,1].map(z=>s(`ring-${x}-${z}`,V(x*(size.x/2-.2),.09,z*(size.z/2-.25)),'ring')))];
  if(kind==='pontoon')return [s('handle-0',V(-2,.3,0),'handle'),s('handle-1',V(2,.3,0),'handle'),s('lock-front',V(2.5,.325,0),'lock'),s('lock-rear',V(-2.5,.325,0),'lock'),s('ring',V(3,0,0),'ring')];
  if(kind==='ferry-deck')return [
    ...[-1,1].flatMap(x=>[-1,1].map(z=>s(`lock-${x}-${z}`,V(x*2.5,-.1,z*1.7),'lock'))),
    s('drive',V(-4.2,-.05,2),'drive'),s('control',V(-3.6,.65,1.5),'control'),s('ring-front',V(4.1,.15,0),'ring'),s('ring-rear',V(-4.1,.15,0),'ring'),
  ];
  if(kind==='lift')return [s('control',V(-3.5,.8,1.6),'control'),s('ring-front',V(3.8,.15,0),'ring'),s('ring-rear',V(-3.8,.15,0),'ring')];
  if(kind==='winch')return [s('drum',V(size.x/2+.04,.1,0),'control'),s('base',V(0,-size.y/2+.12,0),'ring'),s('handle-0',V(0,.3,0),'handle')];
  if(kind==='jack')return [s('control',V(0,.15,.28),'control'),s('head',V(0,.3,0),'ring'),s('handle-0',V(0,.2,0),'handle')];
  if(kind==='anchor')return [s('ring',V(0,.35,0),'ring'),s('handle-0',V(0,.3,0),'handle')];
  if(kind==='drive')return [s('handle-0',V(-.05,.6,0),'handle'),s('drive',V(.55,.55,0),'drive'),s('ring',V(0,.3,0),'ring')];
  if(kind==='barrier')return [s('control',V(0,.3,1.5),'control')];
  const large=['generator-large','mast','pump-large'].includes(kind);
  const sockets:LocalSocket[]=[s('handle-0',V(0,-size.y/2+.2,-size.z/2),'handle'),s('handle-1',V(0,-size.y/2+.2,size.z/2),'handle')];
  for(const x of [-1,1])for(const z of [-1,1])sockets.push(s(`ring-${x}-${z}`,V(x*(size.x/2-.15),-size.y/2+.18,z*(size.z/2-.08)),'ring'));
  if(large)sockets.push(s('top-ring',V(0,size.y/2,0),'ring'));
  return sockets;
}
