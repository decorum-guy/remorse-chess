import { BUILDINGS, RULES } from '../core/constants'
import { getMap } from '../core/maps'
import type { BuildingKind, GameEvent, MapData, Point, Rect, Team, WorldView } from '../core/types'
import { visibleContours, type Stage, type StageOptions, type StageState } from './scene'
import type { Settings } from './settings'

const SQUASH = Math.sqrt(3) / 2
const COLOR = { A: '#47c9e5', B: '#ffb25b', neutral: '#e5d8ac' }
type Effect = { event: GameEvent; until: number }

/** Plan-view presentation consumes the same filtered view as WebGL, including memory and public radar. */
export class CanvasStage implements Stage {
  private canvas = document.createElement('canvas')
  private fog = document.createElement('canvas')
  private context: CanvasRenderingContext2D
  private view: WorldView | null = null
  private map: MapData | null = null
  private settings: Settings
  private state: StageState = { selected: [], hover: null, preview: null, zoom: 1, target: null, aim: null, focus: [] }
  private scale = 1
  private ox = 0
  private oz = 0
  private resize: ResizeObserver
  private raf = 0
  private frames = 0
  private started = performance.now()
  private lastViewAt = 0
  private lastSeq = -1
  private effects: Effect[] = []
  private previousFrameAt = performance.now()
  private poses = new Map<string, { x: number; z: number; angle: number; generation: number }>()
  constructor(private host: HTMLElement, settings: Settings, private options: Partial<StageOptions> = {}) {
    this.settings = settings; this.context = this.canvas.getContext('2d')!; this.canvas.setAttribute('aria-hidden', 'true'); host.append(this.canvas)
    this.fog.width = 512; this.fog.height = 384
    this.resize = new ResizeObserver(() => this.size()); this.resize.observe(host); this.size(); this.raf = requestAnimationFrame(this.draw)
  }
  private size(): void {
    const r = this.host.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, this.settings.quality === 'low' ? 1 : 1.75)
    this.canvas.width = Math.max(1, Math.floor(r.width * dpr)); this.canvas.height = Math.max(1, Math.floor(r.height * dpr)); this.canvas.style.width = '100%'; this.canvas.style.height = '100%'
  }
  setView(view: WorldView): void {
    const now = performance.now()
    if (this.view?.matchId !== view.matchId || view.tick < this.view.tick || now - this.lastViewAt > 500) { this.lastSeq = -1; this.effects = []; this.poses.clear() }
    if (this.lastSeq >= 0) for (const event of view.events) {
      if (event.seq <= this.lastSeq || view.tick - event.tick > 3 || event.type.startsWith('sound:') || !event.point) continue
      if (event.type === 'shot' || event.type === 'muzzle' || event.type === 'hit' || event.type === 'blocked') this.effects.push({ event, until: now + (event.type === 'shot' ? 80 : 100) })
    }
    this.lastSeq = Math.max(this.lastSeq, ...view.events.map(event => event.seq), 0)
    const alive = new Set([...view.units, ...view.transports].map(entity => entity.id)); for (const id of this.poses.keys()) if (!alive.has(id)) this.poses.delete(id)
    this.lastViewAt = now; this.view = view; this.map = getMap(view.mapId)
    const ctx = this.fog.getContext('2d')!, sx = this.fog.width / this.map.width, sz = this.fog.height / this.map.height
    ctx.clearRect(0, 0, this.fog.width, this.fog.height); ctx.fillStyle = 'rgba(9,23,31,.59)'; ctx.fillRect(0, 0, this.fog.width, this.fog.height); ctx.globalCompositeOperation = 'destination-out'
    for (const contour of visibleContours(view, this.map)) {
      ctx.beginPath(); contour.forEach((p, i) => i ? ctx.lineTo(p.x * sx, p.z * sz) : ctx.moveTo(p.x * sx, p.z * sz)); ctx.closePath(); ctx.fillStyle = '#000'; ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  setSettings(settings: Settings): void { const resize = settings.quality !== this.settings.quality; this.settings = settings; if (resize) this.size() }
  setState(state: StageState): void { this.state = { ...state, focus: state.focus ?? [] } }
  private teamAt(side: 'L' | 'R'): Team { return this.view?.teams.A.side === side ? 'A' : 'B' }
  private rect(rect: Rect, fill: string, stroke?: string): void {
    const ctx = this.context; ctx.fillStyle = fill; ctx.fillRect(rect.x1, rect.z1, rect.x2 - rect.x1, rect.z2 - rect.z1)
    if (stroke) { ctx.strokeStyle = stroke; ctx.strokeRect(rect.x1, rect.z1, rect.x2 - rect.x1, rect.z2 - rect.z1) }
  }
  private path(points: Point[], color: string, width = .08, closed = false): void {
    const ctx = this.context; ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z)); if (closed) ctx.closePath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke()
  }
  private ring(x: number, z: number, radius: number, color: string, width = .09, end = Math.PI * 2): void {
    const ctx = this.context; ctx.beginPath(); ctx.arc(x, z, radius, -Math.PI / 2, -Math.PI / 2 + end); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke()
  }
  private badge(x: number, z: number, team: Team, radius = .25, label?: string): void {
    const ctx = this.context, sides = team === 'A' ? 3 : 6
    ctx.beginPath(); for (let n = 0; n < sides; n++) { const a = n / sides * Math.PI * 2 - Math.PI / 2; const px = x + Math.cos(a) * radius, pz = z + Math.sin(a) * radius; if (n) ctx.lineTo(px, pz); else ctx.moveTo(px, pz) }
    ctx.closePath(); ctx.fillStyle = COLOR[team]; ctx.fill(); ctx.strokeStyle = '#162830'; ctx.lineWidth = .045; ctx.stroke(); if (label) { ctx.font = 'bold .25px ForpostText, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#10212b'; ctx.fillText(label, x, z + (team === 'A' ? .06 : .01)) }
  }
  private health(x: number, z: number, ratio: number, color: string, thin = false): void {
    const ctx = this.context, height = thin ? .07 : .12; ctx.fillStyle = '#17262a'; ctx.fillRect(x - .55, z, 1.1, height); ctx.fillStyle = color; ctx.fillRect(x - .55, z, 1.1 * Math.max(0, Math.min(1, ratio)), height)
  }
  private text(text: string, x: number, z: number, color = '#e5e8d6', size = .48): void {
    const ctx = this.context; ctx.font = `bold ${size}px ForpostDisplay, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = .07; ctx.strokeStyle = '#13252c'; ctx.strokeText(text, x, z); ctx.fillStyle = color; ctx.fillText(text, x, z)
  }
  private terrain(map: MapData, view: WorldView): void {
    const ctx = this.context
    ctx.fillStyle = map.id === 'FP03' ? '#b9a47b' : map.id === 'FP02' ? '#78877e' : '#929b8f'; ctx.fillRect(0, 0, map.width, map.height)
    ctx.strokeStyle = map.id === 'FP03' ? '#ab956e' : '#718178'; ctx.lineWidth = .04
    for (let x = 1; x < map.width; x += 4) { ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x, map.height - 1); ctx.stroke() }
    for (let z = 1; z < map.height; z += 4) { ctx.beginPath(); ctx.moveTo(1, z); ctx.lineTo(map.width - 1, z); ctx.stroke() }
    for (const water of map.water) { ctx.lineWidth = .13; this.rect(water, map.id === 'FP02' ? '#1d5762' : '#27636a', '#cbd0bc'); ctx.strokeStyle = '#5c9290'; ctx.lineWidth = .025; for (let z = water.z1 + .45; z < water.z2 - .2; z += .7) this.path([{ x: water.x1 + .3, z }, { x: water.x2 - .3, z }], '#508480', .025) }
    for (const side of ['L', 'R'] as const) {
      const team = this.teamAt(side), base = map.bases[side], depot = map.depots[side]
      ctx.lineWidth = .09; this.rect(map.protected[side], team === 'A' ? '#376b73' : '#886d44', COLOR[team])
      for (const route of ['N', 'S'] as const) { const points = map.routes[side][route]; this.path(points, '#4f615c', 3); ctx.setLineDash([.7, 1.3]); this.path(points, team === 'A' ? '#88bfc4' : '#e4b779', .07); ctx.setLineDash([]) }
      this.ring(base.x, base.z, 3, COLOR[team]); this.building('post', base.x, base.z, team, true, 0, false, undefined, 1.3)
      ctx.save(); ctx.translate(depot.x, depot.z); ctx.fillStyle = '#40535a'; ctx.fillRect(-1.4, -1.25, 2.8, 2.5); ctx.fillStyle = '#d0c4a1'; for (let i = -1; i <= 1; i++) ctx.fillRect(i * .85 - .3, -.8, .6, .95); ctx.strokeStyle = COLOR[team]; ctx.lineWidth = .12; ctx.strokeRect(-1.4, -1.25, 2.8, 2.5); ctx.restore()
    }
    for (const pad of map.pads) {
      ctx.strokeStyle = this.state.selected.includes(pad.id) ? '#fff4c9' : '#ded9bb'; ctx.lineWidth = this.state.selected.includes(pad.id) ? .14 : .055
      ctx.strokeRect(pad.rect.x1, pad.rect.z1, pad.rect.x2 - pad.rect.x1, pad.rect.z2 - pad.rect.z1)
      this.text(pad.id.replace(/^.*-/, ''), pad.x, pad.rect.z2 + .24, '#c6cdb9', .31)
    }
    for (const wall of view.walls) if (!wall.destructible || wall.hp > 0) {
      this.rect({ x1: wall.x1 + .13, x2: wall.x2 + .13, z1: wall.z1 + .2, z2: wall.z2 + .2 }, '#344640')
      const gradient = ctx.createLinearGradient(wall.x1, wall.z1, wall.x2, wall.z2); gradient.addColorStop(0, wall.destructible ? '#d3ba8f' : '#d6d8c9'); gradient.addColorStop(1, wall.destructible ? '#97805f' : '#9aa89f'); ctx.fillStyle = gradient; ctx.fillRect(wall.x1, wall.z1, wall.x2 - wall.x1, wall.z2 - wall.z1)
      this.path([{ x: wall.x1, z: wall.z2 }, { x: wall.x2, z: wall.z2 }], '#52665f', .13)
      if (wall.destructible) { ctx.setLineDash([.25, .25]); this.path([{ x: wall.x1 + .12, z: wall.z1 + .12 }, { x: wall.x2 - .12, z: wall.z2 - .12 }], '#514e36', .12); ctx.setLineDash([]); this.health((wall.x1 + wall.x2) / 2, wall.z1 - .3, wall.hp / wall.maxHp, COLOR.neutral) }
    }
    for (const station of view.stations) {
      const color = station.owner ? COLOR[station.owner] : COLOR.neutral
      this.ring(station.x, station.z, 2.5, color, .08); this.ring(station.x, station.z, 1.15, '#b1b5a2', .18); ctx.fillStyle = '#3a5158'; ctx.fillRect(station.x - .7, station.z - .7, 1.4, 1.4); this.ring(station.x, station.z, .45, color, .17)
      if (station.capturing) this.ring(station.x, station.z, 2.37, COLOR[station.capturing], .16, Math.PI * 2 * station.captureTicks / RULES.captureTicks)
    }
    this.ring(map.complex.x, map.complex.z, 3, COLOR.neutral); this.ring(map.complex.x, map.complex.z, 1.8, COLOR.neutral, .2)
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; this.path([{ x: map.complex.x + Math.cos(a) * .9, z: map.complex.z + Math.sin(a) * .9 }, { x: map.complex.x + Math.cos(a) * 1.65, z: map.complex.z + Math.sin(a) * 1.65 }], '#435a60', .2) }
    ctx.drawImage(this.fog, 0, 0, map.width, map.height)
    ctx.strokeStyle = '#d1d4c0'; ctx.lineWidth = .4; ctx.strokeRect(.25, .25, map.width - .5, map.height - .5)
  }
  private building(kind: BuildingKind, x: number, z: number, team: Team | null, powered: boolean, angle: number, unfinished = false, rect?: Rect, scale = 1): void {
    const ctx = this.context, color = team ? COLOR[team] : COLOR.neutral, signal = powered ? color : '#74847c'
    ctx.save(); ctx.translate(x, z); ctx.scale(scale, scale)
    if (kind === 'bridge' && rect) {
      const width = rect.x2 - rect.x1, depth = rect.z2 - rect.z1; ctx.fillStyle = '#536970'; ctx.fillRect(-width / 2, -depth / 2, width, depth); ctx.strokeStyle = '#b5bba9'; ctx.lineWidth = .08
      for (let n = -width / 2 + .2; n < width / 2; n += .4) this.path([{ x: n, z: -depth / 2 + .2 }, { x: n, z: depth / 2 - .2 }], '#9ba99f', .08)
      ctx.fillStyle = color; ctx.fillRect(-width / 2, -depth / 2, width, .12); ctx.fillRect(-width / 2, depth / 2 - .12, width, .12)
    } else {
      ctx.fillStyle = '#233740'; ctx.beginPath(); ctx.moveTo(-.78, -.9); ctx.lineTo(.78, -.9); ctx.lineTo(.9, -.78); ctx.lineTo(.9, .78); ctx.lineTo(.78, .9); ctx.lineTo(-.78, .9); ctx.lineTo(-.9, .78); ctx.lineTo(-.9, -.78); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#b8c1ad'; ctx.lineWidth = .1; ctx.stroke()
      ctx.fillStyle = color; ctx.fillRect(-.67, .65, 1.34, .09)
      if (unfinished) { ctx.setLineDash([.18, .15]); ctx.strokeStyle = color; ctx.lineWidth = .1; ctx.strokeRect(-.65, -.65, 1.3, 1.3); ctx.setLineDash([]); this.path([{ x: -.45, z: -.45 }, { x: .45, z: .45 }], '#b9bd9e', .08) }
      else if (kind === 'relay') { this.ring(0, 0, .57, signal, .13); ctx.fillStyle = '#c9d2c1'; ctx.fillRect(-.1, -.65, .2, 1.3); ctx.fillRect(-.4, -.5, .8, .13); ctx.fillStyle = signal; ctx.fillRect(-.34, -.34, .68, .18) }
      else if (kind === 'generator') { for (const bx of [-.38, .38]) { ctx.fillStyle = '#c8cfb9'; ctx.fillRect(bx - .24, -.55, .48, 1.02); ctx.fillStyle = signal; ctx.fillRect(bx - .17, -.42, .34, .16); this.ring(bx, .05, .18, '#3e535a', .09) } }
      else if (kind === 'extractor') { ctx.fillStyle = '#afbaac'; ctx.fillRect(-.65, -.15, 1.3, .3); ctx.fillRect(-.14, -.65, .28, 1.3); this.ring(0, -.05, .34, signal, .17); this.path([{ x: -.6, z: -.6 }, { x: .6, z: .6 }], '#4c6669', .14) }
      else if (kind === 'turret' || kind === 'battery') { ctx.rotate(angle); ctx.fillStyle = '#a9b8b2'; ctx.fillRect(-.55, -.43, .95, .86); ctx.fillStyle = signal; ctx.fillRect(-.45, -.28, .45, .56); ctx.fillStyle = '#d5dfcc'; if (kind === 'battery') { ctx.fillRect(.15, -.3, 1.3, .16); ctx.fillRect(.15, .14, 1.3, .16); ctx.fillStyle = signal; ctx.fillRect(.3, -.07, 1, .14) } else { ctx.fillRect(.1, -.1, 1.0, .2); ctx.fillStyle = '#253e47'; ctx.fillRect(.88, -.13, .28, .26) } }
      else if (kind === 'dock') { ctx.fillStyle = '#cad1bf'; ctx.fillRect(-.65, -.65, 1.3, .22); ctx.fillRect(-.65, -.65, .18, 1.2); ctx.fillRect(.47, -.65, .18, 1.2); ctx.fillRect(-.07, -.4, .14, .95); ctx.fillStyle = signal; ctx.fillRect(-.42, .16, .32, .32); ctx.fillRect(.1, .16, .32, .32) }
      else if (kind === 'post') { ctx.fillStyle = '#c8d0bf'; ctx.fillRect(-.7, -.62, 1.4, .24); ctx.fillRect(-.7, -.62, .18, 1.2); ctx.fillRect(.52, -.62, .18, 1.2); ctx.fillStyle = signal; ctx.fillRect(-.33, -.03, .66, .17); ctx.fillRect(-.085, -.28, .17, .66) }
    }
    ctx.restore()
  }
  private network(view: WorldView, map: MapData): void {
    if (view.participants.find(p => p.id === view.you)?.mode !== 'tactics' && !this.state.preview) return
    const base = map.bases[view.teams[view.yourTeam].side], color = COLOR[view.yourTeam], linked = [{ ...base, radius: 14 }], waiting = view.buildings.filter(b => b.team === view.yourTeam && b.kind === 'relay' && b.powered)
    const ctx = this.context; ctx.save(); ctx.globalAlpha = .4; this.ring(base.x, base.z, 14, color, .045)
    for (let attempts = 0; attempts <= view.buildings.length && waiting.length; attempts++) for (let i = waiting.length - 1; i >= 0; i--) {
      const relay = waiting[i], parent = [...linked].sort((a, b) => Math.hypot(a.x - relay.x, a.z - relay.z) - Math.hypot(b.x - relay.x, b.z - relay.z)).find(p => Math.hypot(p.x - relay.x, p.z - relay.z) <= p.radius + .001)
      if (parent) { this.ring(relay.x, relay.z, 12, color, .045); this.path([parent, relay], color, .06); linked.push({ x: relay.x, z: relay.z, radius: 12 }); waiting.splice(i, 1) }
    }
    ctx.restore()
  }
  private pose(id: string, x: number, z: number, angle: number, generation: number, dt: number, predicted = false): { x: number; z: number; angle: number } {
    let pose = this.poses.get(id)
    if (!pose || pose.generation !== generation) { pose = { x, z, angle, generation }; this.poses.set(id, pose) }
    const amount = this.settings.reducedMotion || Math.hypot(x - pose.x, z - pose.z) > 3 ? 1 : 1 - Math.exp(-dt / (predicted ? .04 : .075))
    pose.x += (x - pose.x) * amount; pose.z += (z - pose.z) * amount; pose.angle = angle
    return pose
  }
  private draw = (now: number): void => {
    const dt = Math.min(.1, (now - this.previousFrameAt) / 1000); this.previousFrameAt = now
    const ctx = this.context, w = this.canvas.width, h = this.canvas.height; ctx.fillStyle = '#101c24'; ctx.fillRect(0, 0, w, h)
    if (this.map && this.view) {
      const map = this.map, view = this.view, own = view.participants.find(p => p.id === view.you), tactics = own?.mode === 'tactics'
      const rawPrediction = !tactics ? this.options.getPrediction?.() ?? null : null, prediction = rawPrediction && Number.isFinite(rawPrediction.x + rawPrediction.z + rawPrediction.angle) ? rawPrediction : null
      const units = view.units.map(u => { const p = u.kind === 'fighter' && u.ownerId === view.you && prediction?.id === u.id ? prediction : null; return { ...u, ...this.pose(u.id, p?.x ?? u.x, p?.z ?? u.z, p?.angle ?? u.angle, u.generation, dt, !!p) } })
      const transports = view.transports.map(t => ({ ...t, ...this.pose(t.id, t.x, t.z, t.angle, 0, dt) })), fighter = units.find(u => u.kind === 'fighter' && u.ownerId === view.you)
      const worldWidth = tactics ? Math.max(map.width + 5, (map.height * SQUASH + 5) * w / h) / this.state.zoom : (this.host.clientWidth < 600 ? 24 : 38) / this.state.zoom
      this.scale = w / worldWidth; const target = tactics ? this.state.target ?? { x: map.width / 2, z: map.height / 2 } : fighter ?? map.bases[view.teams[view.yourTeam].side]
      const cx = Math.max(Math.min(worldWidth / 2, map.width / 2), Math.min(Math.max(map.width - worldWidth / 2, map.width / 2), target.x)), hz = h / this.scale / SQUASH / 2, cz = Math.max(Math.min(hz, map.height / 2), Math.min(Math.max(map.height - hz, map.height / 2), target.z))
      this.ox = w / 2 - cx * this.scale; this.oz = h / 2 - cz * this.scale * SQUASH
      ctx.save(); ctx.translate(this.ox, this.oz); ctx.scale(this.scale, this.scale * SQUASH); ctx.lineJoin = 'miter'
      this.terrain(map, view); this.network(view, map)
      for (const padId of view.publicBridges) if (!view.buildings.some(b => b.padId === padId) && !view.memories.some(m => m.padId === padId)) { const pad = map.pads.find(p => p.id === padId); if (pad) this.building('bridge', pad.x, pad.z, null, false, 0, false, pad.rect) }
      for (const memory of view.memories) {
        const pad = map.pads.find(p => p.id === memory.padId); ctx.save(); ctx.globalAlpha = .42; this.building(memory.kind, memory.x, memory.z, null, false, 0, false, pad?.rect); ctx.restore()
        if (this.state.selected.includes(memory.id) || this.state.hover === memory.id) { ctx.setLineDash([.18, .14]); this.ring(memory.x, memory.z, 1.2, '#bdc9bd'); ctx.setLineDash([]); this.text(`${Math.floor((view.tick - memory.seenTick) / 30)}${this.settings.language === 'ru' ? ' с' : ' s'}`, memory.x, memory.z - 1.4, '#b8c6bd', .45) }
      }
      for (const b of view.buildings) {
        const pad = map.pads.find(p => p.id === b.padId), unfinished = b.completedTick === null, selected = this.state.selected.includes(b.id), hover = this.state.hover === b.id
        this.building(b.kind, b.x, b.z, b.team, b.powered, b.angle, unfinished, pad?.rect); this.health(b.x, b.z - 1.15, b.hp / b.maxHp, COLOR[b.team]); this.badge(b.x - .68, b.z + .7, b.team, .18)
        if (unfinished && b.workTicks !== undefined) this.health(b.x, b.z - 1.02, b.workTicks / BUILDINGS[b.kind].workTicks, COLOR.neutral, true)
        else if (b.droneQueue?.length) this.health(b.x, b.z - 1.02, b.droneQueue[0].workTicks / RULES.droneWorkTicks, COLOR.neutral, true)
        if (!b.powered && !unfinished) { this.path([{ x: b.x + .45, z: b.z - .65 }, { x: b.x + .7, z: b.z - .25 }, { x: b.x + .35, z: b.z - .25 }, { x: b.x + .6, z: b.z + .1 }], '#afb4a6', .11); this.path([{ x: b.x + .2, z: b.z }, { x: b.x + .8, z: b.z - .6 }], '#e9b077', .055) }
        if (b.suppressed) this.ring(b.x, b.z, 1.02, '#ef7b6d', .13)
        if (b.sellUntil !== undefined && b.sellUntil !== null) { ctx.setLineDash([.18, .12]); this.ring(b.x, b.z, 1.1, COLOR.neutral, .1); ctx.setLineDash([]) }
        if (selected || hover) this.ring(b.x, b.z, 1.22, selected ? '#fff6d1' : COLOR[b.team], selected ? .13 : .08)
      }
      for (const t of transports) {
        ctx.save(); ctx.translate(t.x, t.z); ctx.rotate(t.angle); ctx.fillStyle = '#22363d'; ctx.fillRect(-1.4, -.8, 2.8, 1.6); ctx.fillStyle = '#b1bcae'; ctx.fillRect(-1, -.64, 1.45, 1.28); ctx.fillStyle = COLOR[t.team]; ctx.fillRect(-.85, -.48, 1.15, .96); ctx.fillStyle = '#46646b'; ctx.fillRect(.65, -.53, .52, 1.06); ctx.fillStyle = '#e0dfbd'; ctx.fillRect(1.12, -.55, .17, .25); ctx.fillRect(1.12, .3, .17, .25); ctx.fillStyle = '#17262c'; for (const z of [-.92, .72]) for (const x of [-1.02, .25, .78]) ctx.fillRect(x, z, .4, .2); ctx.restore()
        this.badge(t.x, t.z, t.team, .3); this.health(t.x, t.z - 1.22, t.hp / t.maxHp, COLOR[t.team]); if (t.unloadTicks !== undefined && t.unloadTicks > 0) { this.ring(t.x, t.z, 1.65, COLOR.neutral, .09); this.ring(t.x, t.z, 1.76, COLOR[t.team], .14, t.unloadTicks / RULES.unloadTicks * Math.PI * 2) }
        if (this.state.selected.includes(t.id) || this.state.hover === t.id) this.ring(t.x, t.z, 1.85, '#fff6d1')
      }
      for (const u of units) {
        ctx.save(); ctx.translate(u.x, u.z); ctx.rotate(u.angle); ctx.fillStyle = '#20363d'; ctx.beginPath(); ctx.ellipse(0, .06, .55, .42, 0, 0, Math.PI * 2); ctx.fill()
        if (u.kind === 'fighter') { ctx.fillStyle = '#b7c8c0'; ctx.fillRect(-.32, -.3, .55, .6); ctx.fillStyle = COLOR[u.team]; ctx.fillRect(-.26, -.27, .32, .54); ctx.fillStyle = '#344e5a'; ctx.fillRect(.02, -.2, .27, .4); ctx.fillStyle = '#dae0cc'; const length = u.weapon === 'rifle' ? .85 : u.weapon === 'shotgun' ? .56 : .7; ctx.fillRect(.1, .15, length, u.weapon === 'shotgun' ? .16 : .1); ctx.fillStyle = '#c0c8b5'; ctx.fillRect(-.38, -.4, .24, .14); ctx.fillRect(-.38, .26, .24, .14) }
        else if (u.kind === 'builder') { ctx.fillStyle = '#c7cdb9'; ctx.fillRect(-.4, -.3, .65, .6); ctx.fillStyle = COLOR[u.team]; ctx.fillRect(-.32, -.2, .44, .4); this.path([{ x: .1, z: .1 }, { x: .4, z: -.15 }, { x: .7, z: .05 }], '#bdcbbb', .14); ctx.fillStyle = '#192d35'; ctx.fillRect(-.43, -.4, .7, .12); ctx.fillRect(-.43, .28, .7, .12) }
        else { ctx.fillStyle = '#b6c6bd'; ctx.beginPath(); ctx.moveTo(.4, 0); ctx.lineTo(.15, -.32); ctx.lineTo(-.38, -.26); ctx.lineTo(-.38, .26); ctx.lineTo(.15, .32); ctx.closePath(); ctx.fill(); ctx.fillStyle = COLOR[u.team]; ctx.fillRect(-.22, -.18, .36, .36); ctx.fillStyle = '#e0e5cf'; ctx.fillRect(.13, -.06, .55, .12) }
        ctx.restore(); this.health(u.x, u.z - .77, u.hp / u.maxHp, COLOR[u.team]); this.badge(u.x - .42, u.z + .4, u.team, .17)
        if (u.protected) { ctx.setLineDash([.18, .13]); this.ring(u.x, u.z, .72, '#dcf8f1'); ctx.setLineDash([]) }
        if (u.kind === 'fighter') { const participant = view.participants.find(p => p.id === u.ownerId); if (participant) { this.badge(u.x, u.z - 1.16, u.team, .36, `${u.team}${participant.seat}`); const automated = participant.controller === 'bot' ? this.settings.language === 'ru' ? 'БОТ' : 'BOT' : participant.temporaryBot ? this.settings.language === 'ru' ? 'АВТО' : 'AUTO' : ''; if (automated) this.text(automated, u.x, u.z - 1.7, COLOR[u.team], .35) } }
        if (this.state.selected.includes(u.id) || this.state.hover === u.id || u.ownerId === view.you && u.kind === 'fighter') this.ring(u.x, u.z, .65, this.state.selected.includes(u.id) ? '#fff6d1' : COLOR[u.team], .09)
      }
      for (const smoke of view.smokes) { const gradient = ctx.createRadialGradient(smoke.x, smoke.z, smoke.radius * .2, smoke.x, smoke.z, smoke.radius); gradient.addColorStop(0, '#b4c2b779'); gradient.addColorStop(1, '#bccbb138'); ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(smoke.x, smoke.z, smoke.radius, 0, Math.PI * 2); ctx.fill(); this.ring(smoke.x, smoke.z, smoke.radius, '#d3dfd0', .065) }
      for (const barrier of view.barriers) { this.path([barrier.a, barrier.b], '#132e3c', .25); this.path([barrier.a, barrier.b], COLOR[barrier.team], .13) }
      this.effects = this.effects.filter(effect => now < effect.until)
      for (const { event } of this.effects) if (event.point) {
        if (event.type === 'shot' && event.end) this.path([event.point, event.end], event.label === 'battery' ? '#b9efff' : '#fff0a8', .06)
        else if (!this.settings.reducedMotion) { this.ring(event.point.x, event.point.z, event.type === 'muzzle' ? .17 : .12, '#fff2c6', .11) }
      }
      if (this.state.preview) {
        const pad = map.pads.find(p => p.id === this.state.preview!.padId), option = view.buildOptions[this.state.preview.padId]?.find(o => o.kind === this.state.preview!.kind)
        if (pad) { const color = option?.ok ? '#9de5a9' : '#f18c7e'; ctx.save(); ctx.globalAlpha = .28; this.rect(pad.rect, color); ctx.restore(); ctx.setLineDash([.22, .15]); this.ring(pad.x, pad.z, pad.kind === 'bridge' ? 2.5 : 1.35, color, .13); ctx.setLineDash([]) }
      }
      if (view.mode === 'tutorial') for (const [index, point] of this.state.focus.entries()) { ctx.setLineDash([.23, .15]); this.ring(point.x, point.z, .95, '#fff1a0', .13); ctx.setLineDash([]); this.path([{ x: point.x - .28, z: point.z }, { x: point.x + .28, z: point.z }], '#fff1a0', .1); this.path([{ x: point.x, z: point.z - .28 }, { x: point.x, z: point.z + .28 }], '#fff1a0', .1); this.text(String(index + 1), point.x, point.z - 1.2, '#fff1a0', .5) }
      if (this.state.aim && fighter && own?.mode === 'fighter') { const a = Math.atan2(this.state.aim.z - fighter.z, this.state.aim.x - fighter.x), length = Math.min(12, Math.hypot(this.state.aim.x - fighter.x, this.state.aim.z - fighter.z)); ctx.save(); ctx.globalAlpha = .5; this.path([fighter, { x: fighter.x + Math.cos(a) * length, z: fighter.z + Math.sin(a) * length }], '#f0f1d7', .045); ctx.restore(); this.ring(this.state.aim.x, this.state.aim.z, .28, '#fff', .075) }
      ctx.restore()
    }
    this.frames++; this.raf = requestAnimationFrame(this.draw)
  }
  worldPoint(clientX: number, clientY: number): Point { const r = this.host.getBoundingClientRect(), dpr = this.canvas.width / r.width; return { x: ((clientX - r.left) * dpr - this.ox) / this.scale, z: ((clientY - r.top) * dpr - this.oz) / this.scale / SQUASH } }
  metrics(): { frames: number; elapsed: number; drawCalls: number; triangles: number } { return { frames: this.frames, elapsed: performance.now() - this.started, drawCalls: 0, triangles: 0 } }
  destroy(): void { cancelAnimationFrame(this.raf); this.resize.disconnect(); this.canvas.remove() }
}
