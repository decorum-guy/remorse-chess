import type { TyagaView } from '../core/types';

const CUES: Record<string, string> = { jump: 'jump', land: 'land', attach: 'attach', strap: 'strap', detach: 'detach', repair: 'repair', checkpoint: 'checkpoint', vote: 'vote', success: 'success', finish: 'success', damage: 'cargo-damage', lost: 'cargo-lost', 'cargo-lost': 'cargo-lost', 'rope-break': 'rope-break', 'deck-unfold': 'deck-unfold', unpack: 'impact-metal', 'anchor-installed': 'attach', jack: 'jack', splash: 'splash', brake: 'brake', 'impact-wood': 'impact-wood', 'wind-gust': 'wind-gust' };
export class TyagaAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer>>();
  private voices = new Set<AudioBufferSourceNode>();
  private loops = new Map<string, { source: AudioBufferSourceNode; gain: GainNode }>();
  private pendingLoops = new Set<string>();
  private desiredLoops = new Map<string, { amount: number; rate: number }>();
  private generation = 0;
  private lastEvent: number | null = null;
  private lastStepTick = 0;
  private lastWinch: { id: string; angle: number } | null = null;
  private muted = false;
  private volume = .6;
  private closed = false;
  async unlock() {
    if (this.closed) return;
    if (!this.context) {
      this.context = new AudioContext(); this.master = this.context.createGain();
      const limiter = this.context.createDynamicsCompressor(); limiter.threshold.value = -12; limiter.knee.value = 12; limiter.ratio.value = 5; this.master.connect(limiter); limiter.connect(this.context.destination);
      this.setPreferences(this.muted, this.volume);
    }
    await this.context.resume();
  }
  setPreferences(muted: boolean, volume: number) { this.muted = muted; this.volume = volume; if (this.master && this.context) this.master.gain.setTargetAtTime(muted ? 0 : volume * .55, this.context.currentTime, .035); }
  private buffer(name: string) {
    if (!this.buffers.has(name)) this.buffers.set(name, fetch(import.meta.env.BASE_URL + 'assets/tyaga/audio/' + name + '.wav').then(r => { if (!r.ok) throw new Error('audio unavailable'); return r.arrayBuffer(); }).then(b => { if (!this.context) throw new Error('audio closed'); return this.context.decodeAudioData(b); }).catch(error => { this.buffers.delete(name); throw error; }));
    return this.buffers.get(name)!;
  }
  async play(name: string, gain = .6) {
    if (!this.context || this.context.state !== 'running' || this.closed || this.muted || this.voices.size >= 16) return;
    const generation = this.generation;
    try {
      const buffer = await this.buffer(name); if (this.closed || this.muted || !this.context || this.context.state !== 'running' || !this.master || generation !== this.generation || this.voices.size >= 16) return;
      const source = this.context.createBufferSource(); source.buffer = buffer;
      const channel = this.context.createGain(); channel.gain.value = gain; source.connect(channel); channel.connect(this.master); this.voices.add(source);
      source.onended = () => { this.voices.delete(source); source.disconnect(); channel.disconnect(); }; source.start();
    } catch { /* A missing cue is reported by the content validator, never blocks control. */ }
  }
  private async loop(name: string, amount: number, rate = 1) {
    this.desiredLoops.set(name, { amount, rate });
    if (!this.context || !this.master || this.closed) return;
    const current = this.loops.get(name);
    if (current) { current.gain.gain.setTargetAtTime(amount, this.context.currentTime, .15); current.source.playbackRate.setTargetAtTime(rate, this.context.currentTime, .15); return; }
    if (amount <= 0 || this.pendingLoops.has(name)) return;
    this.pendingLoops.add(name);
    const generation = this.generation;
    try {
      const buffer = await this.buffer(name), desired = this.desiredLoops.get(name);
      if (this.closed || !this.context || !this.master || generation !== this.generation || !desired || desired.amount <= 0 || this.loops.has(name)) return;
      const source = this.context.createBufferSource(); source.buffer = buffer; source.loop = true; source.playbackRate.value = desired.rate;
      const gain = this.context.createGain(); gain.gain.value = desired.amount; source.connect(gain); gain.connect(this.master); source.start(); this.loops.set(name, { source, gain });
    } catch { /* Same local bank validation as one-shots. */ }
    finally { this.pendingLoops.delete(name); }
  }
  update(view: TyagaView) {
    if (this.lastEvent === null) this.lastEvent = view.events.at(-1)?.id ?? 0;
    for (const event of view.events) if (event.id > this.lastEvent) { const name = CUES[event.type]; if (name) void this.play(name); }
    this.lastEvent = Math.max(this.lastEvent, view.events.at(-1)?.id ?? 0);
    const participant = view.participants.find(p => p.participantId === view.participantId), self = view.entities.find(e => e.id === participant?.entityId);
    const truck = view.entities.find(e => e.kind === 'truck');
    const distance = self && truck ? Math.hypot(self.position.x - truck.position.x, self.position.z - truck.position.z) : 20;
    const attenuation = Math.max(0, 1 - distance / 24), moving = view.phase === 'running';
    void this.loop('engine', moving && view.truck.driver ? .18 * attenuation : 0, .75 + Math.abs(view.truck.speed) * .15);
    void this.loop('engine-load', moving && view.truck.speed > .2 ? .11 * attenuation * Math.min(1, view.truck.load / view.truck.capacity) : 0, .8 + view.truck.speed * .1);
    void this.loop('wind', moving && view.map.windProfile ? view.weather.gust ? .2 : .08 : 0);
    void this.loop('water', moving && view.map.waterVolumes.length ? .07 : 0);
    const rope = view.connections.some(c => c.kind === 'rope' && !c.broken && c.tension > c.limit * .6);
    void this.loop('rope-strain', moving && rope ? .12 : 0);
    const controlledCable = view.connections.find(c => c.id === participant?.controlling && c.kind === 'rope' && !c.broken);
    const operating = controlledCable ? view.entities.find(e => e.id === controlledCable.fromId) : undefined;
    const drumAngle = operating?.mechanism?.drumAngle ?? 0;
    const turning = !!operating && this.lastWinch?.id === operating.id && Math.abs(drumAngle - this.lastWinch.angle) > .0001;
    this.lastWinch = operating ? { id: operating.id, angle: drumAngle } : null;
    void this.loop('winch-idle', moving && operating && !turning ? .05 : 0);
    void this.loop('winch', moving && turning ? .13 : 0);
    if (self && ['walk', 'run'].includes(self.animation ?? '') && moving && view.tick - this.lastStepTick > (self.animation === 'run' ? 17 : 26)) {
      this.lastStepTick = view.tick; const material = self.material === 'steel' || self.material === 'wet-stone' ? 'stone' : self.material ?? 'soil'; void this.play('step-' + material, .25);
    }
  }
  silence() { this.generation++; this.desiredLoops.clear(); for (const { gain } of this.loops.values()) if (this.context) gain.gain.setTargetAtTime(0, this.context.currentTime, .08); for (const source of this.voices) source.stop(); }
  resetEvents() { this.lastEvent = null; this.lastStepTick = 0; this.lastWinch = null; this.silence(); }
  close() { this.closed = true; this.silence(); for (const loop of this.loops.values()) { loop.source.stop(); loop.source.disconnect(); loop.gain.disconnect(); } this.loops.clear(); void this.context?.close(); this.context = null; }
}
