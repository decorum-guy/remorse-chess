import type { BenchEvent } from './types';

export interface BenchSoundState {
  motor: string;
  speed: number;
  throttle: number;
  surface: 'concrete' | 'wet' | 'ribs';
  active: boolean;
}
type Loop = { source: AudioBufferSourceNode; gain: GainNode };

/** Samples are original generator output. A user gesture is required for unlock(). */
export class BenchAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private samples = new Map<string, Promise<AudioBuffer | null>>();
  private loops = new Map<string, Loop>();
  private pendingLoops = new Set<string>();
  private seen = new Set<string>();
  private firstSnapshot = true;
  private volume = .65;
  private musicVolume = .22;
  private disposed = false;
  private state: BenchSoundState = { motor: 'economy', speed: 0, throttle: 0, surface: 'concrete', active: false };
  private hidden = false;
  private runIdentity = '';
  private visibilityHandler = () => { this.hidden = document.hidden; this.update(this.state); };

  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain(); this.master.gain.value = this.volume; this.master.connect(this.context.destination);
      this.musicGain = this.context.createGain(); this.musicGain.gain.value = this.musicVolume; this.musicGain.connect(this.master);
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    void this.ensureLoop('workshop'); void this.ensureLoop('music', true);
    this.update(this.state);
  }

  setVolumes(master: number, music: number): void {
    this.volume = Math.max(0, Math.min(1, master)); this.musicVolume = Math.max(0, Math.min(1, music));
    if (this.context && this.master && this.musicGain) {
      this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, .03);
      this.musicGain.gain.setTargetAtTime(this.musicVolume, this.context.currentTime, .03);
    }
  }

  /** Call with a new match/practice run identity before its first snapshot. */
  resetEvents(runIdentity: string): void {
    if (runIdentity === this.runIdentity) return;
    this.runIdentity = runIdentity; this.seen.clear(); this.firstSnapshot = true;
  }

  private sample(id: string): Promise<AudioBuffer | null> {
    let pending = this.samples.get(id);
    if (!pending) {
      const context = this.context;
      pending = context ? fetch(`/test-bench/audio/${id}.wav`).then(async response => {
        if (!response.ok) return null;
        return context.decodeAudioData(await response.arrayBuffer());
      }).catch(() => null) : Promise.resolve(null);
      this.samples.set(id, pending);
    }
    return pending;
  }

  private async ensureLoop(id: string, music = false): Promise<void> {
    if (!this.context || !this.master || this.disposed || this.loops.has(id) || this.pendingLoops.has(id)) return;
    this.pendingLoops.add(id);
    try {
      const buffer = await this.sample(id);
      if (!buffer || this.disposed || !this.context || !this.master) return;
      const source = this.context.createBufferSource(); source.buffer = buffer; source.loop = true;
      const gain = this.context.createGain(); gain.gain.value = 0; source.connect(gain); gain.connect(music ? this.musicGain! : this.master);
      source.start(); this.loops.set(id, { source, gain }); this.update(this.state);
    } finally { this.pendingLoops.delete(id); }
  }

  update(state: BenchSoundState): void {
    this.state = state;
    if (!this.context || this.disposed) return;
    const active = state.active && !this.hidden;
    const motor = ['speed', 'torque', 'economy'].includes(state.motor) ? state.motor : 'economy';
    if (active) { void this.ensureLoop(`motor-${motor}`); void this.ensureLoop(`surface-${state.surface}`); }
    for (const [id, loop] of this.loops) {
      let gain = 0;
      if (id === `motor-${motor}` && active) gain = .24 + Math.abs(state.throttle) * .50;
      if (id === `surface-${state.surface}` && active) gain = Math.min(.65, Math.abs(state.speed) / 7);
      if (id === 'workshop' && !this.hidden) gain = active ? .20 : .75;
      if (id === 'music' && !this.hidden) gain = active ? .60 : 1;
      loop.gain.gain.setTargetAtTime(gain, this.context.currentTime, .08);
      if (id.startsWith('motor-')) loop.source.playbackRate.setTargetAtTime(.78 + Math.min(1.7, Math.abs(state.speed) / 5 + Math.abs(state.throttle) * .25), this.context.currentTime, .05);
    }
  }

  /** Prime the first received snapshot, then play only new committed event IDs. */
  syncEvents(events: readonly BenchEvent[], restored = false): void {
    if (this.firstSnapshot || restored) {
      events.forEach(event => this.seen.add(event.id)); this.firstSnapshot = false; return;
    }
    for (const event of events) this.event(event.id, event.kind, event.amount);
  }

  event(id: string, type: string, amount?: number): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    const sound: Record<string, string> = {
      attach: 'attach', blueprint: 'attach', cancel: 'cancel', loaded: 'load', 'picked-up': 'load',
      lost: 'impact-2', broken: 'crack', gate: 'gate', restored: 'reset', delivered: 'deliver',
      depleted: 'depleted', timeout: 'finish', start: 'start', finish: 'finish',
    };
    const asset = type === 'damaged' ? `impact-${(amount ?? 0) >= 40 ? 3 : (amount ?? 0) >= 15 ? 2 : 1}` : sound[type];
    if (!asset || !this.context || !this.master || this.hidden || this.disposed) return;
    const queuedAt = this.context.currentTime;
    void this.sample(asset).then(buffer => {
      if (!buffer || !this.context || !this.master || this.disposed || this.hidden || this.context.currentTime - queuedAt > .8) return;
      const source = this.context.createBufferSource(); source.buffer = buffer;
      const gain = this.context.createGain(); gain.gain.value = type === 'broken' ? .60 : .78;
      source.connect(gain); gain.connect(this.master); source.onended = () => { source.disconnect(); gain.disconnect(); }; source.start();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true; document.removeEventListener('visibilitychange', this.visibilityHandler);
    for (const loop of this.loops.values()) { loop.source.stop(); loop.source.disconnect(); loop.gain.disconnect(); }
    this.loops.clear(); if (this.context) await this.context.close(); this.context = null;
  }
}
