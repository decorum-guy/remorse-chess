import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { DriveInput } from './types';
import type { BenchPreferences, Control } from './preferences';
export function useDrivingControls(active:boolean,preferences:BenchPreferences,input:MutableRefObject<DriveInput>,onInteract:()=>void,onRestore:()=>void) {
  const keys=useRef(new Set<string>());const touch=useRef({throttle:0,steering:0,brake:false,restore:false});
  const stopped=useRef(false);
  const actions=useRef({onInteract,onRestore});actions.current={onInteract,onRestore};
  const [hold,setHold]=useState(0);const holdStart=useRef<number|null>(null);const fired=useRef(false);
  const beginHold=()=>{if(active&&holdStart.current===null){holdStart.current=performance.now();fired.current=false;setHold(0);}};
  const sampleHold=()=>{
    if(!active||holdStart.current===null)return;
    const progress=Math.min(1,Math.max(0,(performance.now()-holdStart.current)/600));setHold(progress);
    if(progress>=1&&!fired.current){fired.current=true;actions.current.onRestore();}
  };
  const clearHold=()=>{holdStart.current=null;fired.current=false;setHold(0);};
  const finishHold=()=>{sampleHold();clearHold();};
  const restorePress=()=>{if(!active)return;touch.current.restore=true;stopped.current=false;beginHold();};
  const restoreRelease=()=>{const wasHeld=touch.current.restore;touch.current.restore=false;if(wasHeld&&!keys.current.has(preferences.keys.restore))finishHold();};
  const restoreCancel=()=>{
    const wasHeld=touch.current.restore;touch.current.restore=false;
    // A button's cancelled/lost pointer cannot cancel an independent keyboard
    // hold. Normal pointerup is also followed by lostpointercapture.
    if(wasHeld&&!keys.current.has(preferences.keys.restore))clearHold();
  };
  useEffect(()=>{
    const down=(event:KeyboardEvent)=>{
      if(!active||event.ctrlKey||event.metaKey||event.altKey||event.target instanceof Element&&event.target.closest('input,select,textarea,[role=slider],dialog,[contenteditable=true]'))return;
      if((event.code==='Space'||event.code==='Enter')&&event.target instanceof Element&&event.target.closest('button,a,[role=button]'))return;
      if(Object.values(preferences.keys).includes(event.code)||event.code.startsWith('Arrow'))event.preventDefault();
      stopped.current=false;
      keys.current.add(event.code);
      // The hold belongs to the actual press, not to a later timer sample.
      if(event.code===preferences.keys.restore)beginHold();
      if(event.code===preferences.keys.interact&&!event.repeat)actions.current.onInteract();
    };
    const up=(event:KeyboardEvent)=>{
      const wasHeld=keys.current.delete(event.code);
      // A long task can delay every periodic sample until after keyup. Still
      // honour one completed hold, while a short tap never queues a reset.
      if(wasHeld&&event.code===preferences.keys.restore&&!touch.current.restore)finishHold();
    };
    const clear=()=>{keys.current.clear();touch.current={throttle:0,steering:0,brake:false,restore:false};input.current={throttle:0,steering:0,brake:true};stopped.current=true;clearHold();};
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',clear);
    document.addEventListener('visibilitychange',clear);
    const timer=setInterval(()=>{
      const pressed=(control:Control,arrow?:string)=>keys.current.has(preferences.keys[control])||!!arrow&&keys.current.has(arrow);
      if(touch.current.throttle||touch.current.steering||touch.current.brake)stopped.current=false;
      if(active&&!stopped.current){input.current={throttle:pressed('throttle','ArrowUp')?1:pressed('reverse','ArrowDown')?-1:touch.current.throttle,steering:pressed('left','ArrowLeft')?-1:pressed('right','ArrowRight')?1:touch.current.steering,brake:pressed('brake')||touch.current.brake};}
      else input.current={throttle:0,steering:0,brake:true};
      const resetting=active&&(pressed('restore')||touch.current.restore);
      if(resetting)sampleHold();
      else clearHold();
    },1000/30);
    return()=>{clear();clearInterval(timer);window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',clear);document.removeEventListener('visibilitychange',clear);};
  },[active,preferences.keys,input]);
  return {touch,hold,restorePress,restoreRelease,restoreCancel};
}
