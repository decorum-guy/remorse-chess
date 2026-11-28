/** Local original sound bank. No hidden emitter coordinates are accepted by this mixer. */
export const FORPOST_SOUNDS = ['carbine','shotgun','rifle','drone-fire','turret-fire','battery-fire','empty','reload-start','reload-end','barrier','smoke','repair','order','error','menu','build-start','build-complete','destroy','power-lost','transport-spawn','unload-start','unload-interrupted','unload-success','station-captured','respawn','overtime','operation-end','hit','engine-loop'] as const;
export type ForpostSound = typeof FORPOST_SOUNDS[number];
interface Voice { source: AudioBufferSourceNode; gain: GainNode; level: number; priority: number; group: 'combat' | 'ui'; }
export interface SoundOptions { volume?: number; sector?: number; proximity?: 'near' | 'far'; occluded?: boolean; }
const UI = new Set<ForpostSound>(['empty','order','error','menu']);
const SOUND_GAIN: Partial<Record<ForpostSound, number>> = { 'drone-fire': .72, 'turret-fire': .8, 'battery-fire': .95, empty: .65, 'reload-start': .66, 'reload-end': .7, barrier: .85, smoke: .7, repair: .65, order: .75, error: .7, menu: .55, 'build-start': .72, 'build-complete': .8, destroy: .9, 'power-lost': .75, 'transport-spawn': .8, 'unload-start': .72, 'unload-interrupted': .8, 'unload-success': .85, 'station-captured': .8, respawn: .72, overtime: .9, 'operation-end': .95, hit: .58, 'engine-loop': .4 };
const CRITICAL = new Set<ForpostSound>(['operation-end','overtime','unload-success']);
export class ForpostAudio {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private effects: GainNode | undefined;
  private interfaceGain: GainNode | undefined;
  private readonly buffers = new Map<ForpostSound, AudioBuffer>();
  private readonly voices: Voice[] = [];
  private loaded: Promise<void> | undefined;
  private settings = { master: .7, effects: .8, ui: .6, muted: false };
  private onVisibility = (): void => { if (document.hidden) this.clear(); };
  private readonly baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl; if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility); }
  /** Call directly from a user click/press. No autoplay is attempted. */
  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain(); this.effects = this.context.createGain(); this.interfaceGain = this.context.createGain();
      this.effects.connect(this.master); this.interfaceGain.connect(this.master); this.master.connect(this.context.destination);
      this.configure(this.settings);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    if (!this.loaded) {
      const context = this.context;
      this.loaded = Promise.all(FORPOST_SOUNDS.map(async (name) => {
        const prefix = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
        const response = await fetch(`${prefix}assets/forpost/audio/${name}.wav`);
        if (!response.ok) throw new Error(`Forpost audio ${response.status}`);
        this.buffers.set(name, await context.decodeAudioData(await response.arrayBuffer()));
      })).then(() => undefined).catch((error: unknown) => { this.loaded = undefined; throw error; });
    }
    await this.loaded;
  }
  configure(settings: Partial<typeof this.settings>): void {
    this.settings = { ...this.settings, ...settings };
    const cap = (v: number) => Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.settings.muted ? 0 : cap(this.settings.master);
    if (this.effects) this.effects.gain.value = cap(this.settings.effects);
    if (this.interfaceGain) this.interfaceGain.gain.value = cap(this.settings.ui);
    if (this.settings.muted) this.clear();
  }
  play(name: ForpostSound, options: SoundOptions = {}): boolean {
    const context = this.context, buffer = this.buffers.get(name);
    if (!context || !buffer || context.state !== 'running' || this.settings.muted || typeof document !== 'undefined' && document.hidden) return false;
    const group = UI.has(name) ? 'ui' : 'combat';
    const priority = CRITICAL.has(name) ? 3 : 1;
    const level = Math.max(0, Math.min(1, options.volume ?? 1)) * (options.proximity === 'far' ? .38 : 1) * (SOUND_GAIN[name] ?? 1);
    const current = this.voices.filter((v) => v.group === group);
    if (current.length >= (group === 'ui' ? 2 : 12)) {
      current.sort((a,b) => a.priority - b.priority || a.level - b.level);
      const victim = current[0]!;
      if (victim.priority > priority) return false;
      victim.source.stop(); this.remove(victim);
    }
    const source = context.createBufferSource(); source.buffer = buffer;
    const gain = context.createGain(); gain.gain.value = level;
    const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = options.occluded ? 1400 : 19000;
    const pan = context.createStereoPanner();
    // Quantized sector only: this cannot encode an exact hidden position or moving trajectory.
    // Server sectors use atan2(Z, X): sector zero is east, the right side of the fixed camera.
    pan.pan.value = options.sector === undefined || !Number.isFinite(options.sector) ? 0 : Math.round(Math.cos((Math.floor(options.sector) % 8) * Math.PI / 4) * 2) / 2;
    source.connect(filter); filter.connect(pan); pan.connect(gain); gain.connect(group === 'ui' ? this.interfaceGain! : this.effects!);
    const voice = { source, gain, level, priority, group } satisfies Voice;
    this.voices.push(voice); source.onended = () => { this.remove(voice); source.disconnect(); filter.disconnect(); pan.disconnect(); gain.disconnect(); };
    source.start(); return true;
  }
  /** Call on disconnect/reconnect, hidden tab, and leaving a match. Old events must not replay. */
  clear(): void { for (const v of [...this.voices]) { v.source.stop(); this.remove(v); } }
  private remove(voice: Voice): void { const i = this.voices.indexOf(voice); if (i >= 0) this.voices.splice(i,1); }
  get activeVoices(): number { return this.voices.length; }
  async dispose(): Promise<void> { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility); this.clear(); await this.context?.close(); }
}
