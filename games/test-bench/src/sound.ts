import { useEffect, useRef } from 'react';
import { BenchAudio } from './Audio';
import type { BenchPreferences } from './preferences';
import type { DriveInput, LaneSnapshot, TrackDefinition } from './types';
import { isWet } from './tracks';
export function useBenchAudio(preferences:BenchPreferences){
  const sound=useRef<BenchAudio|null>(null);
  if(!sound.current)sound.current=new BenchAudio();
  const disposal=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>{
    clearTimeout(disposal.current);
    const current=sound.current!;
    const unlock=()=>{void current.unlock().catch(()=>{});};
    document.addEventListener('pointerdown',unlock);document.addEventListener('keydown',unlock);
    return()=>{document.removeEventListener('pointerdown',unlock);document.removeEventListener('keydown',unlock);disposal.current=setTimeout(()=>{void current.dispose();},0);};
  },[]);
  useEffect(()=>{sound.current?.setVolumes(preferences.volume,preferences.music);},[preferences.volume,preferences.music]);
  return sound;
}
export function updateSound(audio:BenchAudio|null,lane:LaneSnapshot|null|undefined,track:TrackDefinition|undefined,input:DriveInput,active:boolean,restoring=false){
  if(!audio)return;
  if(!lane||!track){audio.update({motor:'economy',speed:0,throttle:0,surface:'concrete',active:false});return;}
  const position=lane.car.position;
  const surface=isWet(track,position.x,position.z)?'wet':track.ribs.some(rib=>Math.abs(rib.z-position.z)<.8)?'ribs':'concrete';
  audio.update({motor:lane.blueprint.motor,speed:lane.car.speed,throttle:input.throttle,surface,active:active&&!lane.finished});
  audio.syncEvents(lane.events,restoring);
}
