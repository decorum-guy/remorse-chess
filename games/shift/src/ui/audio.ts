import { useEffect, useRef, useState } from 'react';
import { worldPosition } from '../core/geometry';
import type { ShiftView } from '../core/types';
import type { Preferences } from './preferences';
let context: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer>>();
export function unlockAudio() {
  if (typeof AudioContext === 'undefined') return;
  try {
    context ??= new AudioContext();
    if (context.state !== 'running') void context.resume().then(() => window.dispatchEvent(new Event('shift-audio-ready'))).catch(() => {});
    else window.dispatchEvent(new Event('shift-audio-ready'));
  } catch { /* Audio availability does not stop a match. */ }
}
async function buffer(name: string): Promise<AudioBuffer> {
  if (!context) throw new Error('Audio awaits a user gesture');
  if (!buffers.has(name)) buffers.set(name, fetch(`/shift-assets/audio/${name}.wav`).then(r => { if (!r.ok) throw new Error('Audio unavailable'); return r.arrayBuffer(); }).then(data => context!.decodeAudioData(data)).catch(error => { buffers.delete(name); throw error; }));
  return buffers.get(name)!;
}
const sounds: Record<string, string> = { 'shift-start': 'shift-start', 'shift-end': 'shift-stop', shot: 'pulse', hit: 'hit', pickup: 'pickup', drop: 'drop', return: 'return', delivered: 'delivered', respawn: 'respawn', ping: 'ping', 'round-start': 'ready' };
interface Voice { source: AudioBufferSourceNode; gain: GainNode; panner: StereoPannerNode; factor: number }
interface AudioOwner { active: boolean; generation: number; voices: Set<Voice>; queue: Promise<void> }
function releaseVoice(owner: AudioOwner, voice: Voice) {
  owner.voices.delete(voice); voice.source.onended = null;
  voice.source.disconnect(); voice.gain.disconnect(); voice.panner.disconnect();
}
function invalidate(owner: AudioOwner) {
  owner.generation++; owner.queue = Promise.resolve();
  for (const voice of [...owner.voices]) {
    try { voice.source.stop(); } catch { /* A finished source may already be stopped. */ }
    releaseVoice(owner, voice);
  }
}
async function beforeDeadline(decoded: Promise<AudioBuffer[] | null>, deadline: number): Promise<AudioBuffer[] | null> {
  const remaining = deadline - performance.now(); if (remaining <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([decoded, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), remaining); })]); }
  finally { clearTimeout(timer); }
}
function useLoop(name: string | null, gainValue: number, ready: boolean, playbackRate = 1) {
  useEffect(() => {
    if (!context || !ready || !name || !gainValue) return;
    let active = true, source: AudioBufferSourceNode | null = null;
    const gain = context.createGain(); gain.gain.value = gainValue; gain.connect(context.destination);
    void buffer(name).then(data => { if (!active || !context) return; source = context.createBufferSource(); source.buffer = data; source.loop = true; source.playbackRate.value = playbackRate; source.connect(gain); source.start(); }).catch(() => {});
    return () => { active = false; source?.stop(); source?.disconnect(); gain.disconnect(); };
  }, [name, gainValue, ready, playbackRate]);
}
export function useShiftAudio(view: ShiftView | null, preferences: Preferences) {
  const last = useRef(new Set<string>()), initialized = useRef(false);
  const [ready, setReady] = useState(context?.state === 'running');
  const owner = useRef<AudioOwner>({ active: false, generation: 0, voices: new Set(), queue: Promise.resolve() });
  const latest = useRef({ view, volume: preferences.volume, ready });
  latest.current = { view, volume: preferences.volume, ready };
  useEffect(() => {
    const enabled = () => setReady(context?.state === 'running');
    window.addEventListener('shift-audio-ready', enabled);
    return () => window.removeEventListener('shift-audio-ready', enabled);
  }, []);
  useEffect(() => {
    const scope = owner.current; scope.active = true; scope.generation++;
    return () => { scope.active = false; invalidate(scope); };
  }, [view?.round, view?.self.controllerEpoch]);
  useEffect(() => {
    const scope = owner.current;
    if (preferences.volume <= 0) invalidate(scope);
    else for (const voice of scope.voices) voice.gain.gain.value = preferences.volume * voice.factor;
  }, [preferences.volume]);
  useEffect(() => {
    if (!view) return;
    if (!initialized.current) { for (const e of view.events) last.current.add(e.id); initialized.current = true; }
    for (const event of view.events) {
      if (last.current.has(event.id)) continue;
      last.current.add(event.id);
      if (!context || !ready || !preferences.volume || view.tick - event.tick > 20) continue;
      const name = sounds[event.kind]; if (!name) continue;
      // Only the recipient's permitted event feed supplies audio positions.
      const self = view.actors.find(actor => actor.seatId === view.self.seatId);
      const origin = self ? worldPosition(view.board, self, view.motion, view.tick) : null;
      const position = event.shot?.from || (event.pose ? worldPosition(view.board, event.pose, view.motion, view.tick) : null);
      const pan = origin && position ? Math.max(-.6, Math.min(.6, (position.x - origin.x) / 12)) : 0;
      const scope = owner.current, generation = scope.generation, epoch = view.self.controllerEpoch;
      const deadline = performance.now() + Math.max(0, 20 - Math.max(0, view.tick - event.tick)) * 1000 / 30;
      const parts = [{ name, factor: event.kind === 'shot' ? .25 : .78, rate: view.self.role === 'navigator' && event.kind !== 'shot' ? 1.07 : 1, pan }];
      if (event.kind === 'shift-start' || event.kind === 'shift-end') parts.push({ name: 'door', factor: .9, rate: 1, pan: 0 });
      // Start fetches concurrently, but resolve playback in confirmed event order.
      // A missing file expires rather than holding later fresh cues indefinitely.
      const decoded = Promise.all(parts.map(part => buffer(part.name))).catch(() => null);
      const valid = () => {
        const current = latest.current;
        return scope.active && scope.generation === generation && context?.state === 'running' && current.ready && current.volume > 0 &&
          current.view?.round === event.round && current.view.self.controllerEpoch === epoch &&
          current.view.tick - event.tick <= 20 && performance.now() <= deadline;
      };
      scope.queue = scope.queue.then(async () => {
        if (!valid()) return;
        const data = await beforeDeadline(decoded, deadline);
        if (!data || !valid() || !context) return;
        for (const [index, part] of parts.entries()) {
          const source = context.createBufferSource(), gain = context.createGain(), panner = context.createStereoPanner();
          const voice: Voice = { source, gain, panner, factor: part.factor };
          source.buffer = data[index]; source.playbackRate.value = part.rate;
          gain.gain.value = latest.current.volume * part.factor; panner.pan.value = part.pan;
          source.connect(gain); gain.connect(panner); panner.connect(context.destination);
          scope.voices.add(voice); source.onended = () => releaseVoice(scope, voice); source.start();
        }
      }).catch(() => {});
    }
    if (last.current.size > 3000) last.current = new Set(view.events.map(e => e.id));
  }, [view, preferences.volume, ready]);
  const active = view?.phase === 'active' && !view.recoveryTicksRemaining;
  const charging = active && view.actors.some(actor => actor.team === view.self.team && actor.chargeTicks > 0);
  const moving = view?.motion && view.phase !== 'finished' && !view.recoveryTicksRemaining;
  useLoop(view?.settings.arena && view.phase !== 'finished' ? `${view.settings.arena}-loop` : null, preferences.ambience * .3, ready);
  useLoop(moving ? 'shift-move' : null, preferences.volume * .42, ready, view?.self.role === 'navigator' ? 1.07 : 1);
  useLoop(charging ? 'charge' : null, preferences.volume * .82, ready);
}
