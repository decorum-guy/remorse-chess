import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { animateForpostModel, applyForpostModelState, cloneForpostModel, makeForpostTeamMarker, type ForpostAnimationState, type ForpostModelState } from '../art/models'
import { getMap } from '../core/maps'
import { BUILDINGS, RULES, VISION, WEAPONS } from '../core/constants'
import type { BuildingKind, GameEvent, MapData, Point, Rect, Team, WorldView } from '../core/types'
import type { Settings } from './settings'

const COLORS = { A: '#47c9e5', B: '#ffb25b', neutral: '#ebdca8' }
const assets = `${import.meta.env.BASE_URL}assets/forpost/`
const UP = new THREE.Vector3(0, 1, 0)
const SQRT3_2 = Math.sqrt(3) / 2
const HEIGHT: Record<string, number> = { builder: 1.05, drone: 1.0, transport: 2.0, relay: 2.45, generator: 1.55, extractor: 1.9, turret: 1.85, dock: 1.8, battery: 1.8, respawn: 2.05, bridge: .8, foundation: .7, wall: 1.4, 'wall-destructible': 1.4 }
const contourCache = new WeakMap<MapData, { observer: string; shapes: Map<string, Point[][]> }>()

type SceneEntity = {
  group: THREE.Group; model: string; team: Team | null; object?: THREE.Object3D
  hp: THREE.Mesh; progress: THREE.Mesh; outline: THREE.LineLoop; label?: THREE.Sprite; shield?: THREE.LineLoop; collisionOutline?: THREE.Line
  lastX: number; lastZ: number; distance: number; lastHp?: number; generation?: number
  appearance: ForpostModelState; appearanceKey: string; animation: Partial<ForpostAnimationState>
  ghost: boolean; occluder?: Rect & { height: number }; faded: boolean
}
type TimedEffect = { object: THREE.Object3D; until: number }
type Retiring = { entity: SceneEntity; start: number; duration: number }
export interface StagePrediction extends Point { id: string; angle: number }
export interface StageOptions { onFallback: () => void; onLoadError: (asset: string) => void; getPrediction?: () => StagePrediction | null }
export interface StageState {
  selected: string[]; hover: string | null; preview: { padId: string; kind: BuildingKind } | null
  zoom: number; target: Point | null; aim: Point | null; focus: Point[]
}
export interface StageMetrics {
  frames: number; elapsed: number; drawCalls: number; triangles: number
  renderWall?: { samples: number; p50Ms: number; p95Ms: number; maxMs: number }
  qaPhases?: Record<QaPhaseName, QaTimingSummary> & {
    windowSize: number
    coverage: { samples: string; sceneUpdates: string; nestedPhase: string; scheduling: string; reactRenderAndCommit: 'not-measured'; asyncModelLoading: 'not-measured'; gpuCompletion: 'not-measured' }
  }
}
type QaPhaseName = 'callbackWallMs' | 'timestampAgeMs' | 'cameraWallMs' | 'cameraLayoutReadMs' | 'entityAnimationWallMs' | 'effectsWallMs' | 'renderSubmitWallMs' | 'setViewSyncCallWallMs' | 'setStateSyncCallWallMs'
type QaTimingSummary = { observations: number; samples: number; totalMs: number; p50Ms: number; p95Ms: number; maxMs: number }
const QA_TIMING_WINDOW = 120
/** Numeric presentation timings only. Enabled by the existing CI init-script marker. */
class QaTimingRing {
  private values = new Float64Array(QA_TIMING_WINDOW)
  private observations = 0
  record(value: number): void { this.values[this.observations++ % this.values.length] = Math.max(0, value) }
  summary(): QaTimingSummary {
    const sorted = Array.from(this.values.subarray(0, Math.min(this.observations, this.values.length))).sort((a, b) => a - b)
    return { observations: this.observations, samples: sorted.length, totalMs: sorted.reduce((sum, value) => sum + value, 0), p50Ms: sorted[Math.ceil(sorted.length * .5) - 1] ?? 0, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] ?? 0, maxMs: sorted.at(-1) ?? 0 }
  }
}
function qaTimingRings(): Record<QaPhaseName, QaTimingRing> | null {
  if (typeof window === 'undefined' || !(window as Window & { __forpostQaTiming?: unknown }).__forpostQaTiming) return null
  return { callbackWallMs: new QaTimingRing(), timestampAgeMs: new QaTimingRing(), cameraWallMs: new QaTimingRing(), cameraLayoutReadMs: new QaTimingRing(), entityAnimationWallMs: new QaTimingRing(), effectsWallMs: new QaTimingRing(), renderSubmitWallMs: new QaTimingRing(), setViewSyncCallWallMs: new QaTimingRing(), setStateSyncCallWallMs: new QaTimingRing() }
}
export interface Stage {
  setView(view: WorldView): void
  setSettings(settings: Settings): void
  setState(state: StageState): void
  worldPoint(clientX: number, clientY: number): Point
  destroy(): void
  metrics(): StageMetrics
}
function rectangleMesh(rect: Rect, height: number, material: THREE.Material, y = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(rect.x2 - rect.x1, height, rect.z2 - rect.z1), material)
  mesh.position.set((rect.x1 + rect.x2) / 2, y + height / 2, (rect.z1 + rect.z2) / 2)
  mesh.receiveShadow = true
  return mesh
}
function line(points: Point[], color: string, y = .05, closed = false, dashed = false): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p.x, y, p.z)))
  const options = { color, transparent: true, opacity: .75, depthWrite: false }
  const material = dashed ? new THREE.LineDashedMaterial({ ...options, dashSize: .23, gapSize: .15 }) : new THREE.LineBasicMaterial(options)
  const result = closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material)
  if (dashed) result.computeLineDistances()
  return result
}
function circle(x: number, z: number, radius: number, color: string, y = .07, dashed = false): THREE.LineLoop {
  return line(Array.from({ length: 64 }, (_, i) => ({ x: x + Math.cos(i / 64 * Math.PI * 2) * radius, z: z + Math.sin(i / 64 * Math.PI * 2) * radius })), color, y, true, dashed) as THREE.LineLoop
}
function rayRect(origin: Point, dx: number, dz: number, rect: Rect): number {
  let near = 0, far = Infinity
  // Scalar slabs avoid allocating nested axis arrays for every ray/occluder pair.
  if (Math.abs(dx) < .00001) { if (origin.x < rect.x1 || origin.x > rect.x2) return Infinity }
  else {
    const a = (rect.x1 - origin.x) / dx, b = (rect.x2 - origin.x) / dx
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b))
    if (near > far) return Infinity
  }
  if (Math.abs(dz) < .00001) { if (origin.z < rect.z1 || origin.z > rect.z2) return Infinity }
  else {
    const a = (rect.z1 - origin.z) / dz, b = (rect.z2 - origin.z) / dz
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b))
    if (near > far) return Infinity
  }
  return far >= 0 ? near : Infinity
}
/** Uses only the already permitted team view. It cannot inspect hidden enemy geometry. */
export function visibleContours(view: WorldView, map: MapData): Point[][] {
  const sources: (Point & { radius: number; id?: string })[] = [
    { ...map.bases[view.teams[view.yourTeam].side], radius: VISION.base },
    ...view.units.filter(u => u.team === view.yourTeam).map(u => ({ id: u.id, x: u.x, z: u.z, radius: VISION[u.kind] })),
    ...view.transports.filter(t => t.team === view.yourTeam).map(t => ({ id: t.id, x: t.x, z: t.z, radius: VISION.transport })),
    ...view.buildings.filter(b => b.team === view.yourTeam).map(b => ({ id: b.id, x: b.x, z: b.z, radius: b.powered ? VISION.building : VISION.inactiveBuilding })),
  ]
  const buildingRects = view.buildings.filter(b => b.kind !== 'bridge').map(b => ({ id: b.id, x: b.x, z: b.z, powered: b.powered, rect: map.pads.find(p => p.id === b.padId)!.rect }))
  const walls = view.walls.filter(wall => !wall.destructible || wall.hp > 0)
  const observer = JSON.stringify([view.matchId, view.you, view.yourTeam, view.participants.find(p => p.id === view.you)?.seat, view.operation, view.mapVersion, view.teams.A.side, view.teams.B.side])
  let cache = contourCache.get(map)
  if (!cache || cache.observer !== observer) { cache = { observer, shapes: new Map() }; contourCache.set(map, cache) }
  // Include every geometry input, even when a caller reuses/mutates a view object.
  // Tick, HP above zero, income and presentation settings do not alter sight geometry.
  const key = JSON.stringify([map.width, map.height, sources, buildingRects, walls.map(wall => [wall.x1, wall.z1, wall.x2, wall.z2]), view.smokes.map(smoke => [smoke.x, smoke.z, smoke.radius])])
  const cached = cache.shapes.get(key)
  if (cached) return cached
  const contours = sources.map(source => Array.from({ length: 81 }, (_, i) => {
    const a = i / 80 * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a)
    let radius = source.radius
    for (const wall of walls) radius = Math.min(radius, rayRect(source, dx, dz, wall))
    for (const building of buildingRects) if (building.id !== source.id) radius = Math.min(radius, rayRect(source, dx, dz, building.rect))
    for (const smoke of view.smokes) {
      const ox = source.x - smoke.x, oz = source.z - smoke.z, b = ox * dx + oz * dz, c = ox * ox + oz * oz - smoke.radius ** 2, d = b * b - c
      if (d >= 0) { const near = -b - Math.sqrt(d), far = -b + Math.sqrt(d); if (far >= 0) radius = Math.min(radius, Math.max(1.5, near)) }
    }
    return { x: Math.max(1, Math.min(map.width - 1, source.x + dx * radius)), z: Math.max(1, Math.min(map.height - 1, source.z + dz * radius)) }
  }))
  cache.shapes.set(key, contours)
  while (cache.shapes.size > 4) cache.shapes.delete(cache.shapes.keys().next().value!)
  return contours
}
/** A lowered water plane needs actual holes in the opaque ground surface. */
export function forpostGroundGeometry(map: MapData): THREE.BufferGeometry {
  const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(map.width, 0), new THREE.Vector2(map.width, -map.height), new THREE.Vector2(0, -map.height)])
  for (const water of map.water) shape.holes.push(new THREE.Path([new THREE.Vector2(water.x1, -water.z1), new THREE.Vector2(water.x1, -water.z2), new THREE.Vector2(water.x2, -water.z2), new THREE.Vector2(water.x2, -water.z1)]))
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2)
}

/** Same static segments/triangles and materials, with one draw per layer. */
export function forpostStaticMapLayers(map: MapData): { pads: THREE.LineSegments; roads: THREE.Mesh; kerbs: THREE.Mesh } {
  const padPoints: THREE.Vector3[] = [], roads: THREE.BufferGeometry[] = [], kerbs: THREE.BufferGeometry[] = []
  for (const { rect: r } of map.pads) {
    for (const [x1, z1, x2, z2] of [[r.x1, r.z1, r.x2, r.z1], [r.x2, r.z1, r.x2, r.z2], [r.x2, r.z2, r.x1, r.z2], [r.x1, r.z2, r.x1, r.z1]]) padPoints.push(new THREE.Vector3(x1, .04, z1), new THREE.Vector3(x2, .04, z2))
  }
  for (const side of ['L', 'R'] as const) for (const route of ['N', 'S'] as const) {
    const path = map.routes[side][route]
    for (let i = 1; i < path.length; i++) {
      const p = path[i - 1], q = path[i]
      const geometry = new THREE.PlaneGeometry(Math.hypot(q.x - p.x, q.z - p.z), 3)
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, -Math.atan2(q.z - p.z, q.x - p.x)))
      geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((p.x + q.x) / 2, .018, (p.z + q.z) / 2), rotation, new THREE.Vector3(1, 1, 1)))
      roads.push(geometry)
    }
  }
  for (const r of [{ x1: 0, z1: 0, x2: map.width, z2: .5 }, { x1: 0, z1: map.height - .5, x2: map.width, z2: map.height }, { x1: 0, z1: .5, x2: .5, z2: map.height - .5 }, { x1: map.width - .5, z1: .5, x2: map.width, z2: map.height - .5 }]) kerbs.push(new THREE.BoxGeometry(r.x2 - r.x1, .4, r.z2 - r.z1).translate((r.x1 + r.x2) / 2, .2, (r.z1 + r.z2) / 2))
  const merge = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const result = mergeGeometries(parts)
    for (const part of parts) part.dispose()
    if (!result) throw new Error('forpost:invalid-static-map-geometry')
    return result
  }
  const pads = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(padPoints), new THREE.LineBasicMaterial({ color: '#d7d1b4', transparent: true, opacity: .75, depthWrite: false }))
  const roadMesh = new THREE.Mesh(merge(roads), new THREE.MeshStandardMaterial({ color: '#4f615c', roughness: .96 })); roadMesh.receiveShadow = true
  const kerbMesh = new THREE.Mesh(merge(kerbs), new THREE.MeshStandardMaterial({ color: '#bfc9bc', roughness: .85 })); kerbMesh.receiveShadow = true
  return { pads, roads: roadMesh, kerbs: kerbMesh }
}

function sprite(text: string, color: string, width = 1, team?: Team): THREE.Sprite {
  const [tag, controller] = text.split(' · ')
  const canvas = document.createElement('canvas'); canvas.width = team ? controller ? 320 : 128 : 256; canvas.height = 96
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#10212bd9'; ctx.fillRect(0, 8, canvas.width, 80)
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  if (team) {
    ctx.beginPath(); const sides = team === 'A' ? 3 : 6
    for (let n = 0; n < sides; n++) { const angle = n / sides * Math.PI * 2 - Math.PI / 2, x = 64 + Math.cos(angle) * 44, y = 48 + Math.sin(angle) * 44; if (n) ctx.lineTo(x, y); else ctx.moveTo(x, y) }; ctx.closePath(); ctx.stroke()
    ctx.font = 'bold 32px ForpostText, sans-serif'; ctx.fillText(tag, 64, team === 'A' ? 57 : 49, 60)
    if (controller) { ctx.font = 'bold 38px ForpostText, sans-serif'; ctx.fillText(controller, 214, 50, 190) }
  } else { ctx.strokeRect(2, 10, 252, 76); ctx.font = 'bold 46px ForpostText, sans-serif'; ctx.fillText(text, 128, 50, 244) }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
  const result = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }))
  result.scale.set(width, width * 96 / canvas.width, 1); result.renderOrder = 7
  return result
}

export class ThreeStage implements Stage {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.OrthographicCamera(-25, 25, 20, -20, .1, 200)
  private mapGroup = new THREE.Group()
  private entityGroup = new THREE.Group()
  private networkGroup = new THREE.Group()
  private controlGroup = new THREE.Group()
  private hazardGroup = new THREE.Group()
  private effectGroup = new THREE.Group()
  private aimGroup = new THREE.Group()
  private aimLine = line([{ x: 0, z: 0 }, { x: 0, z: 0 }], '#f5f2d7', .15)
  private aimMarker = circle(0, 0, .28, '#ffffff', .15)
  private entities = new Map<string, SceneEntity>()
  private effects: TimedEffect[] = []
  private retiring: Retiring[] = []
  private loader = new GLTFLoader()
  private models = new Map<string, Promise<THREE.Group>>()
  private view: WorldView | null = null
  private prediction: StagePrediction | null = null
  private map: MapData | null = null
  private mapKey = ''
  private settings: Settings
  private state: StageState = { selected: [], hover: null, preview: null, zoom: 1, target: null, aim: null, focus: [] }
  private networkKey = ''
  private controlKey = ''
  private resize: ResizeObserver
  private raf = 0
  private destroyed = false
  private center = new THREE.Vector3(10, 0, 20)
  private raycaster = new THREE.Raycaster()
  private plane = new THREE.Plane(UP, 0)
  private fogCanvas = document.createElement('canvas')
  private fogTexture: THREE.CanvasTexture
  private fogContours: Point[][] | null = null
  private hazardKey = ''
  private frames = 0
  private renderWallTimes = new Float64Array(120)
  private qaTiming = qaTimingRings()
  private qaCameraLayoutReadMs = 0
  private started = performance.now()
  private previousTime = performance.now()
  private lastViewAt = 0
  private lastEventSeq = -1
  private previousMatch = ''
  private stationModels = new Map<string, THREE.Group>()
  private stationArcs = new Map<string, THREE.Line>()
  private onContextLost: (event: Event) => void
  private inverseRotation = new THREE.Quaternion()
  constructor(private host: HTMLElement, settings: Settings, private options: StageOptions) {
    this.settings = settings
    this.renderer = new THREE.WebGLRenderer({ antialias: settings.quality !== 'low', alpha: false, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, settings.quality === 'low' ? 1 : 1.75))
    this.renderer.setClearColor('#101c24'); this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.shadowMap.enabled = settings.quality !== 'low'; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.25
    this.renderer.domElement.setAttribute('aria-hidden', 'true'); host.append(this.renderer.domElement)
    this.scene.add(new THREE.HemisphereLight('#e1f5fa', '#44574b', 2.1))
    const sun = new THREE.DirectionalLight('#ffedce', 2.8); sun.position.set(-20, 70, 30); sun.castShadow = true
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 150 }); sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -.0005
    this.scene.add(sun, this.mapGroup, this.entityGroup, this.networkGroup, this.controlGroup, this.hazardGroup, this.effectGroup, this.aimGroup)
    this.aimGroup.add(this.aimLine, this.aimMarker); this.aimGroup.visible = false
    this.fogCanvas.width = settings.quality === 'low' ? 256 : 512; this.fogCanvas.height = settings.quality === 'low' ? 192 : 384
    this.fogTexture = new THREE.CanvasTexture(this.fogCanvas); this.fogTexture.colorSpace = THREE.SRGBColorSpace
    this.resize = new ResizeObserver(() => this.size()); this.resize.observe(host); this.size()
    this.onContextLost = event => { event.preventDefault(); this.options.onFallback() }
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost)
    this.raf = requestAnimationFrame(this.frame)
  }
  private size(): void { const r = this.host.getBoundingClientRect(); this.renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false); this.updateCamera(1) }
  private model(id: string): Promise<THREE.Group> {
    const key = `${id}${this.settings.quality === 'low' ? '-low' : ''}`
    if (!this.models.has(key)) this.models.set(key, this.loader.loadAsync(`${assets}models/${key}.glb`).then(gltf => gltf.scene).catch(error => { this.options.onLoadError(key); throw error }))
    return this.models.get(key)!
  }
  private addModel(group: THREE.Group, id: string, appearance: ForpostModelState, scale?: THREE.Vector3, ready?: (model: THREE.Object3D) => void): void {
    void this.model(id).then(template => {
      if (this.destroyed || !group.parent) return
      const model = cloneForpostModel(template, appearance)
      model.traverse(object => { if (object instanceof THREE.Mesh) object.userData.forpostSharedGeometry = true })
      if (scale) model.scale.copy(scale)
      model.userData.forpostBaseScale = model.scale.clone()
      group.add(model); ready?.(model)
    }).catch(() => { /* Visible loading error is reported by the stage owner. */ })
  }
  private teamAt(side: 'L' | 'R'): Team { return this.view?.teams.A.side === side ? 'A' : 'B' }
  private buildMap(map: MapData): void {
    this.clearGroup(this.mapGroup); this.clearGroup(this.entityGroup); this.clearGroup(this.networkGroup); this.clearGroup(this.controlGroup); this.clearGroup(this.hazardGroup); this.clearGroup(this.effectGroup)
    this.entities.clear(); this.stationModels.clear(); this.stationArcs.clear(); this.effects = []; this.retiring = []; this.networkKey = ''; this.controlKey = ''; this.hazardKey = ''; this.fogContours = null
    const groundColor = map.id === 'FP03' ? '#b9a47b' : map.id === 'FP02' ? '#78877e' : '#929b8f'
    // Cut real water holes in the ground surface: a lowered water plane underneath an uncut opaque floor is invisible.
    const ground = new THREE.Mesh(forpostGroundGeometry(map), new THREE.MeshStandardMaterial({ color: groundColor, roughness: .95 })); ground.receiveShadow = true; this.mapGroup.add(ground)
    this.mapGroup.add(rectangleMesh({ x1: 0, z1: 0, x2: map.width, z2: map.height }, .2, new THREE.MeshStandardMaterial({ color: '#45564f', roughness: 1 }), -.6))
    // One line geometry per terrain layer, instead of one draw per tile or road dash.
    const seamPoints: THREE.Vector3[] = []
    const seam = (vertical: boolean, fixed: number, end: number): void => {
      let start = 1
      const cuts = map.water.filter(r => vertical ? fixed >= r.x1 && fixed <= r.x2 : fixed >= r.z1 && fixed <= r.z2).map(r => vertical ? [r.z1, r.z2] : [r.x1, r.x2]).sort((a, b) => a[0] - b[0])
      for (const [near, far] of [...cuts, [end, end]]) { if (near > start) seamPoints.push(new THREE.Vector3(vertical ? fixed : start, .001, vertical ? start : fixed), new THREE.Vector3(vertical ? fixed : near, .001, vertical ? near : fixed)); start = Math.max(start, far) }
    }
    for (let x = 1; x < map.width; x += 4) seam(true, x, map.height - 1)
    for (let z = 1; z < map.height; z += 4) seam(false, z, map.width - 1)
    this.mapGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(seamPoints), new THREE.LineBasicMaterial({ color: '#62736b', transparent: true, opacity: .65 })))
    const staticLayers = forpostStaticMapLayers(map); this.mapGroup.add(staticLayers.pads, staticLayers.roads, staticLayers.kerbs)
    for (const water of map.water) {
      this.mapGroup.add(rectangleMesh(water, .08, new THREE.MeshStandardMaterial({ color: map.id === 'FP02' ? '#1d5762' : '#27636a', roughness: .35, metalness: .3 }), -.23))
      this.mapGroup.add(line([{ x: water.x1, z: water.z1 }, { x: water.x2, z: water.z1 }, { x: water.x2, z: water.z2 }, { x: water.x1, z: water.z2 }], '#ced2bd', .04, true))
    }
    for (const side of ['L', 'R'] as const) {
      const team = this.teamAt(side)
      this.mapGroup.add(rectangleMesh(map.protected[side], .025, new THREE.MeshStandardMaterial({ color: team === 'A' ? '#376b73' : '#886d44', roughness: .8 }), 0))
      for (const route of ['N', 'S'] as const) {
        const path = map.routes[side][route]
        const marks = line(path, team === 'A' ? '#88bfc4' : '#e4b779', .03, false, true)
        const material = marks.material as THREE.LineDashedMaterial; material.dashSize = .7; material.gapSize = 1.3; this.mapGroup.add(marks)
      }
      const base = new THREE.Group(); base.position.set(map.bases[side].x, 0, map.bases[side].z); this.mapGroup.add(base)
      this.addModel(base, 'respawn', { team, powered: true }, new THREE.Vector3(1.6, 1.1, 1.6))
      this.mapGroup.add(circle(map.bases[side].x, map.bases[side].z, 3, COLORS[team]))
      const depot = new THREE.Group(); depot.position.set(map.depots[side].x, 0, map.depots[side].z); this.mapGroup.add(depot); this.addModel(depot, 'depot', { team, powered: true })
    }
    // Bake pad numbers and service paint into one local texture, so tactical readability does not cost a draw call per label.
    const paintCanvas = document.createElement('canvas'); paintCanvas.width = this.settings.quality === 'low' ? 1024 : 2048; paintCanvas.height = Math.round(paintCanvas.width * map.height / map.width)
    const paint = paintCanvas.getContext('2d')!, density = paintCanvas.width / map.width
    paint.scale(density, density); paint.textAlign = 'center'; paint.textBaseline = 'middle'; paint.font = 'bold .38px ForpostDisplay, sans-serif'
    for (const pad of map.pads) { paint.fillStyle = '#e6dfbf'; paint.fillText(pad.id, pad.x, pad.rect.z2 + .37) }
    paint.strokeStyle = '#d6be76'; paint.lineWidth = .09
    for (const side of ['L', 'R'] as const) { const depot = map.depots[side]; for (const offset of [-1.7, 1.7]) { paint.beginPath(); paint.moveTo(depot.x - 1.4, depot.z + offset); paint.lineTo(depot.x + 1.4, depot.z + offset); paint.stroke() } }
    for (const water of map.water) { paint.lineWidth = .11; for (let x = water.x1 + .2; x < water.x2; x += .65) { paint.beginPath(); paint.moveTo(x, water.z1 - .16); paint.lineTo(x + .25, water.z1 - .4); paint.moveTo(x, water.z2 + .16); paint.lineTo(x + .25, water.z2 + .4); paint.stroke() } }
    const paintTexture = new THREE.CanvasTexture(paintCanvas); paintTexture.colorSpace = THREE.SRGBColorSpace
    const paintPlane = new THREE.Mesh(new THREE.PlaneGeometry(map.width, map.height), new THREE.MeshBasicMaterial({ map: paintTexture, transparent: true, depthWrite: false })); paintPlane.rotation.x = -Math.PI / 2; paintPlane.position.set(map.width / 2, .038, map.height / 2); this.mapGroup.add(paintPlane)
    if (map.id === 'FP01') for (const x of [map.width * .2, map.width * .8]) { const crane = new THREE.Group(); crane.position.set(x, -.1, -4.5); this.mapGroup.add(crane); this.addModel(crane, 'crane', { powered: false }) }
    for (const station of map.stations) {
      const group = new THREE.Group(); group.position.set(station.x, 0, station.z); this.mapGroup.add(group); this.stationModels.set(station.id, group)
      const arc = line(Array.from({ length: 49 }, () => ({ x: 0, z: 0 })), COLORS.neutral, .12); arc.visible = false; group.add(arc); this.stationArcs.set(station.id, arc)
      this.addModel(group, 'station', { powered: false }, undefined, () => this.updateStations())
    }
    const complex = new THREE.Group(); complex.position.set(map.complex.x, 0, map.complex.z); this.mapGroup.add(complex); this.addModel(complex, 'complex', { powered: true })
    const fog = new THREE.Mesh(new THREE.PlaneGeometry(map.width, map.height), new THREE.MeshBasicMaterial({ map: this.fogTexture, transparent: true, depthWrite: false }))
    fog.rotation.x = -Math.PI / 2; fog.position.set(map.width / 2, .045, map.height / 2); fog.renderOrder = 1; fog.userData.keepTexture = true; this.mapGroup.add(fog)
    this.center.set(map.width / 2, 0, map.height / 2)
  }
  private updateFog(): void {
    if (!this.view || !this.map) return
    const contours = visibleContours(this.view, this.map)
    if (contours === this.fogContours) return
    this.fogContours = contours
    const ctx = this.fogCanvas.getContext('2d')!, sx = this.fogCanvas.width / this.map.width, sz = this.fogCanvas.height / this.map.height
    ctx.clearRect(0, 0, this.fogCanvas.width, this.fogCanvas.height); ctx.fillStyle = 'rgba(9,23,31,.59)'; ctx.fillRect(0, 0, this.fogCanvas.width, this.fogCanvas.height); ctx.globalCompositeOperation = 'destination-out'
    for (const contour of contours) {
      ctx.beginPath(); contour.forEach((p, i) => i ? ctx.lineTo(p.x * sx, p.z * sz) : ctx.moveTo(p.x * sx, p.z * sz)); ctx.closePath(); ctx.fillStyle = '#000'; ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'; this.fogTexture.needsUpdate = true
  }
  private entity(id: string, model: string, team: Team | null, point: Point, scale?: THREE.Vector3): SceneEntity {
    let entity = this.entities.get(id)
    if (entity && entity.model !== model) { this.clearGroup(entity.group); this.entityGroup.remove(entity.group); this.entities.delete(id); entity = undefined }
    if (!entity) {
      const group = new THREE.Group(); group.position.set(point.x, 0, point.z); this.entityGroup.add(group)
      const height = HEIGHT[model] ?? 1.7
      const hp = new THREE.Mesh(new THREE.PlaneGeometry(1.05, .085), new THREE.MeshBasicMaterial({ color: team ? COLORS[team] : COLORS.neutral, depthTest: false, depthWrite: false }))
      hp.position.y = height; hp.renderOrder = 6; group.add(hp)
      const progress = new THREE.Mesh(new THREE.PlaneGeometry(1.05, .055), new THREE.MeshBasicMaterial({ color: '#ebdca8', depthTest: false, depthWrite: false }))
      progress.position.y = height - .11; progress.renderOrder = 6; progress.visible = false; group.add(progress)
      const outline = circle(0, 0, model === 'transport' ? 1.45 : model.startsWith('fighter') || model === 'drone' || model === 'builder' ? .6 : 1.15, team ? COLORS[team] : COLORS.neutral, .08)
      group.add(outline)
      if (team && ['builder', 'drone', 'transport'].includes(model)) group.add(makeForpostTeamMarker(team, model === 'transport' ? .85 : .38))
      entity = { group, model, team, hp, progress, outline, lastX: point.x, lastZ: point.z, distance: 0, appearance: { ...(team ? { team } : {}), powered: true }, appearanceKey: '', animation: {}, ghost: false, faded: false }
      this.entities.set(id, entity)
      const ownEntity = entity
      this.addModel(group, model, entity.appearance, scale, object => { ownEntity.object = object; this.repaint(ownEntity, true) })
    }
    entity.lastX = point.x; entity.lastZ = point.z
    return entity
  }
  private repaint(entity: SceneEntity, force = false): void {
    const key = JSON.stringify(entity.appearance)
    if (entity.object && (force || key !== entity.appearanceKey)) { applyForpostModelState(entity.object, entity.appearance); entity.appearanceKey = key; entity.faded = false; if (entity.collisionOutline) entity.collisionOutline.visible = false }
  }
  private label(entity: SceneEntity, text: string, color: string, width = .6, team?: Team): void {
    if (entity.label?.userData.text === text) return
    if (entity.label) { this.disposeObject(entity.label); entity.group.remove(entity.label) }
    entity.label = sprite(text, color, width, team); entity.label.userData.text = text; entity.label.position.y = (HEIGHT[entity.model] ?? 1.7) + .25; entity.group.add(entity.label)
  }
  setView(view: WorldView): void {
    const now = performance.now(), previousView = this.view
    const reconnected = this.lastViewAt > 0 && now - this.lastViewAt > 500
    if (view.matchId !== this.previousMatch || view.tick < (this.view?.tick ?? 0) || reconnected) { this.lastEventSeq = -1; this.clearGroup(this.effectGroup); this.effects = [] }
    this.previousMatch = view.matchId; this.view = view; this.lastViewAt = now
    const key = `${view.mapId}:${view.operation}:${view.teams.A.side}:${this.settings.quality}`
    if (key !== this.mapKey) { this.mapKey = key; this.map = getMap(view.mapId); this.buildMap(this.map) }
    const alive = new Set<string>()
    for (const unit of view.units) {
      const participant = view.participants.find(p => p.id === unit.ownerId)
      const entity = this.entity(unit.id, unit.kind === 'fighter' ? `fighter-${unit.weapon ?? participant?.weapon ?? 'carbine'}` : unit.kind, unit.team, unit); alive.add(unit.id)
      if (entity.generation !== unit.generation) { entity.generation = unit.generation; entity.group.position.set(unit.x, 0, unit.z); entity.distance = 0; if (unit.ownerId === view.you && unit.kind === 'fighter') { this.prediction = null; this.center.set(unit.x, 0, unit.z) } }
      this.damageAnimation(entity, unit.hp, now)
      entity.group.rotation.y = -unit.angle - Math.PI / 2; entity.hp.scale.x = Math.max(.01, unit.hp / unit.maxHp)
      entity.appearance = { team: unit.team, healthRatio: unit.hp / unit.maxHp, selected: this.state.selected.includes(unit.id), powered: true }
      const working = unit.kind === 'builder' && !!previousView && view.buildings.some(b => b.ownerId === unit.ownerId && b.workTicks !== undefined && b.workTicks > (previousView.buildings.find(before => before.id === b.id)?.workTicks ?? b.workTicks) && Math.hypot(b.x - unit.x, b.z - unit.z) < 2.5)
      entity.animation = { ...entity.animation, moving: Math.hypot(unit.vx, unit.vz) > .05, working, powered: true }
      const weapon = unit.weapon ?? participant?.weapon ?? 'carbine'
      entity.animation.reloadProgress = unit.reloadUntil && unit.reloadUntil > view.tick ? 1 - Math.min(1, (unit.reloadUntil - view.tick) / WEAPONS[weapon].reloadTicks) : undefined
      if (unit.protected && !entity.shield) { entity.shield = circle(0, 0, .68, '#d9f6f5', .35, true); entity.group.add(entity.shield) }
      if (entity.shield) entity.shield.visible = unit.protected
      if (participant && unit.kind === 'fighter') { const automated = participant.controller === 'bot' ? this.settings.language === 'ru' ? 'БОТ' : 'BOT' : participant.temporaryBot ? this.settings.language === 'ru' ? 'АВТО' : 'AUTO' : ''; this.label(entity, `${unit.team}${participant.seat}${automated ? ` · ${automated}` : ''}`, COLORS[unit.team], automated ? 1.6 : .7, unit.team) }
      this.repaint(entity)
    }
    for (const building of view.buildings) {
      const unfinished = building.completedTick === null
      const model = unfinished && building.workTicks === undefined ? 'foundation' : building.kind === 'post' ? 'respawn' : building.kind
      const pad = this.map!.pads.find(p => p.id === building.padId)!
      const scale = building.kind === 'bridge' ? new THREE.Vector3((pad.rect.x2 - pad.rect.x1) / 4, 1, (pad.rect.z2 - pad.rect.z1) / 4) : undefined
      const entity = this.entity(building.id, model, building.team, building, scale); alive.add(building.id)
      this.damageAnimation(entity, building.hp, now)
      entity.hp.scale.x = Math.max(.01, building.hp / building.maxHp)
      entity.appearance = { team: building.team, healthRatio: building.hp / building.maxHp, powered: building.powered, selected: this.state.selected.includes(building.id) }
      entity.animation = { ...entity.animation, powered: building.powered, working: building.powered && !unfinished, turretYaw: -building.angle - Math.PI / 2, suppressed: building.suppressed, constructionProgress: unfinished && building.workTicks !== undefined ? building.workTicks / BUILDINGS[building.kind].workTicks : undefined }
      if (!unfinished && entity.object) entity.object.scale.y = scale?.y ?? 1
      entity.progress.visible = unfinished && building.workTicks !== undefined || building.kind === 'dock' && !!building.droneQueue?.length
      const progress = unfinished ? (building.workTicks ?? 0) / BUILDINGS[building.kind].workTicks : (building.droneQueue?.[0]?.workTicks ?? 0) / RULES.droneWorkTicks
      entity.progress.scale.x = Math.max(.01, Math.min(1, progress))
      entity.occluder = building.kind === 'bridge' ? undefined : { ...pad.rect, height: Math.min(2.2, (HEIGHT[model] ?? 1.7) - .2) }
      this.occlusionOutline(entity)
      this.repaint(entity)
    }
    for (const memory of view.memories) {
      const id = `memory:${memory.id}`; const model = memory.kind === 'post' ? 'respawn' : memory.kind
      const pad = this.map!.pads.find(p => p.id === memory.padId)!
      const scale = memory.kind === 'bridge' ? new THREE.Vector3((pad.rect.x2 - pad.rect.x1) / 4, 1, (pad.rect.z2 - pad.rect.z1) / 4) : undefined
      const entity = this.entity(id, model, memory.team, memory, scale); alive.add(id); entity.ghost = true; entity.hp.visible = false; entity.progress.visible = false
      entity.appearance = { team: memory.team, healthRatio: memory.hp / memory.maxHp, powered: false, ghost: true, selected: this.state.selected.includes(memory.id) }
      entity.animation = { powered: false, working: false }
      entity.outline.visible = this.state.selected.includes(memory.id) || this.state.hover === memory.id
      if (entity.outline.visible) this.label(entity, `${Math.floor(Math.max(0, view.tick - memory.seenTick) / 30)}${this.settings.language === 'ru' ? ' с' : ' s'}`, '#a9b9b7', 1.1)
      if (entity.label) entity.label.visible = entity.outline.visible
      this.repaint(entity)
    }
    // Public bridges remain visible even when their private owner/building details are absent.
    for (const padId of view.publicBridges) {
      if (view.buildings.some(b => b.padId === padId) || view.memories.some(m => m.padId === padId)) continue
      const pad = this.map!.pads.find(p => p.id === padId)!
      const entity = this.entity(`public-bridge:${padId}`, 'bridge', null, pad, new THREE.Vector3((pad.rect.x2 - pad.rect.x1) / 4, 1, (pad.rect.z2 - pad.rect.z1) / 4)); alive.add(`public-bridge:${padId}`)
      entity.hp.visible = false; entity.outline.visible = false
    }
    for (const transport of view.transports) {
      const entity = this.entity(transport.id, 'transport', transport.team, transport); alive.add(transport.id)
      this.damageAnimation(entity, transport.hp, now)
      entity.group.rotation.y = -transport.angle - Math.PI / 2; entity.hp.scale.x = Math.max(.01, transport.hp / transport.maxHp)
      entity.appearance = { team: transport.team, healthRatio: transport.hp / transport.maxHp, powered: true, selected: this.state.selected.includes(transport.id) }
      entity.animation = { moving: transport.speed !== undefined && transport.speed > 0 && transport.distance < transport.length, powered: true, unloading: transport.unloadTicks !== undefined && transport.unloadTicks > 0 }
      entity.progress.visible = transport.unloadTicks !== undefined && transport.unloadTicks > 0; entity.progress.scale.x = Math.max(.01, (transport.unloadTicks ?? 0) / RULES.unloadTicks)
      this.repaint(entity)
    }
    for (const wall of view.walls) if (!wall.destructible || wall.hp > 0) {
      const entity = this.entity(wall.id, wall.destructible ? 'wall-destructible' : 'wall', null, { x: (wall.x1 + wall.x2) / 2, z: (wall.z1 + wall.z2) / 2 }, new THREE.Vector3(wall.x2 - wall.x1, 1, wall.z2 - wall.z1)); alive.add(wall.id)
      entity.hp.visible = wall.destructible; entity.hp.scale.x = Math.max(.01, wall.hp / wall.maxHp); entity.outline.visible = false; entity.occluder = { ...wall, height: 1.2 }
      this.occlusionOutline(entity)
      entity.appearance = { healthRatio: wall.hp / wall.maxHp }; this.repaint(entity)
    }
    const recent = this.lastEventSeq < 0 ? [] : view.events.filter(e => e.seq > this.lastEventSeq && view.tick - e.tick <= 3)
    this.lastEventSeq = Math.max(this.lastEventSeq, ...view.events.map(e => e.seq), 0)
    const destroyed = new Set(recent.filter(e => e.point && /^(unit|building|transport|wall)-destroyed$/.test(e.type)).map(e => e.actorId))
    for (const [id, entity] of this.entities) if (!alive.has(id)) {
      if (destroyed.has(id) && !entity.ghost) this.retiring.push({ entity, start: now, duration: entity.model.startsWith('fighter') ? 350 : 600 })
      else { this.clearGroup(entity.group); this.entityGroup.remove(entity.group) }
      this.entities.delete(id)
    }
    for (const event of recent) this.event(event, now)
    this.updateStations(); this.updateFog(); this.updateControls(); this.updateNetwork(); this.updateHazards(); this.updateAim()
    if (this.qaTiming) this.qaTiming.setViewSyncCallWallMs.record(performance.now() - now)
  }
  private damageAnimation(entity: SceneEntity, hp: number, now: number): void {
    if (entity.lastHp !== undefined && hp < entity.lastHp) entity.group.userData.hitAt = now
    entity.lastHp = hp
  }
  private occlusionOutline(entity: SceneEntity): void {
    if (!entity.occluder || entity.collisionOutline) return
    const r = entity.occluder, x = entity.lastX, z = entity.lastZ
    entity.collisionOutline = line([{ x: r.x1 - x, z: r.z1 - z }, { x: r.x2 - x, z: r.z1 - z }, { x: r.x2 - x, z: r.z2 - z }, { x: r.x1 - x, z: r.z2 - z }], '#e0dfbc', .055, true)
    entity.collisionOutline.visible = false; entity.group.add(entity.collisionOutline)
  }
  private updateStations(): void {
    if (!this.view) return
    for (const station of this.view.stations) {
      const group = this.stationModels.get(station.id)
      if (!group) continue
      const arc = this.stationArcs.get(station.id)
      if (arc) {
        arc.visible = !!station.capturing
        if (station.capturing) {
          const positions = arc.geometry.getAttribute('position') as THREE.BufferAttribute, amount = Math.max(0, Math.min(1, station.captureTicks / RULES.captureTicks))
          for (let i = 0; i < positions.count; i++) { const a = -Math.PI / 2 + i / (positions.count - 1) * Math.PI * 2 * amount; positions.setXYZ(i, Math.cos(a) * 2.37, .12, Math.sin(a) * 2.37) }
          positions.needsUpdate = true; arc.geometry.computeBoundingSphere(); (arc.material as THREE.LineBasicMaterial).color.set(COLORS[station.capturing])
        }
      }
      group.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (!(material instanceof THREE.MeshStandardMaterial) || !/signal|team/i.test(material.name)) continue
          material.color.set(station.owner ? COLORS[station.owner] : COLORS.neutral); material.emissive.copy(material.color); material.emissiveIntensity = station.owner ? .8 : .1
        }
      })
    }
  }
  private event(event: GameEvent, now: number): void {
    if (event.type.startsWith('sound:')) return
    if (event.type === 'shot' && event.point && event.end) {
      const tracer = line([event.point, event.end], event.label === 'battery' ? '#aeeaf8' : '#fff1b3', .65)
      this.effectGroup.add(tracer); this.effects.push({ object: tracer, until: now + 80 })
    }
    if (event.type === 'muzzle' && event.point) {
      if (event.actorId) { const entity = this.entities.get(event.actorId); if (entity) entity.group.userData.shotAt = now }
      if (!this.settings.reducedMotion) {
        const flash = new THREE.Mesh(new THREE.OctahedronGeometry(.13), new THREE.MeshBasicMaterial({ color: '#fff2ce', depthWrite: false }))
        const source = event.actorId ? this.entities.get(event.actorId)?.object?.getObjectByName('socket_muzzle') : undefined
        if (source) source.getWorldPosition(flash.position); else flash.position.set(event.point.x, .84, event.point.z)
        this.effectGroup.add(flash); this.effects.push({ object: flash, until: now + 65 })
      }
    }
    if ((event.type === 'hit' || event.type === 'blocked') && event.point && !this.settings.reducedMotion) {
      const spark = new THREE.Mesh(new THREE.OctahedronGeometry(.09), new THREE.MeshBasicMaterial({ color: '#f5cf81' })); spark.position.set(event.point.x, .6, event.point.z); this.effectGroup.add(spark); this.effects.push({ object: spark, until: now + 100 })
    }
  }
  private updateNetwork(): void {
    if (!this.view || !this.map) return
    const own = this.view.participants.find(p => p.id === this.view!.you)
    const enabled = own?.mode === 'tactics' || !!this.state.preview
    const relays = this.view.buildings.filter(b => b.kind === 'relay' && b.team === this.view!.yourTeam && b.powered)
    const key = enabled ? `${this.view.teams[this.view.yourTeam].side}:${relays.map(b => `${b.id}:${b.x}:${b.z}`).join('|')}` : 'off'
    if (key === this.networkKey) return
    this.networkKey = key; this.clearGroup(this.networkGroup)
    if (!enabled) return
    const team = this.view.yourTeam, base = this.map.bases[this.view.teams[team].side]
    const linked: (Point & { radius: number })[] = [{ ...base, radius: 14 }]
    const waiting = [...relays]
    this.networkGroup.add(circle(base.x, base.z, 14, COLORS[team], .065))
    for (let attempts = 0; waiting.length && attempts < relays.length + 1; attempts++) {
      for (let i = waiting.length - 1; i >= 0; i--) {
        const relay = waiting[i], parent = [...linked].sort((a, b) => Math.hypot(a.x - relay.x, a.z - relay.z) - Math.hypot(b.x - relay.x, b.z - relay.z)).find(p => Math.hypot(p.x - relay.x, p.z - relay.z) <= p.radius + .001)
        if (!parent) continue
        this.networkGroup.add(circle(relay.x, relay.z, 12, COLORS[team], .065)); this.networkGroup.add(line([parent, relay], COLORS[team], .11)); linked.push({ x: relay.x, z: relay.z, radius: 12 }); waiting.splice(i, 1)
      }
    }
  }
  private updateControls(): void {
    if (!this.view || !this.map) return
    const previewOption = this.state.preview ? this.view.buildOptions[this.state.preview.padId]?.find(o => o.kind === this.state.preview!.kind) : undefined
    const key = JSON.stringify({ selected: this.state.selected, preview: this.state.preview, previewOk: previewOption?.ok, focus: this.view.mode === 'tutorial' ? this.state.focus : [] })
    for (const [id, entity] of this.entities) {
      const selected = this.state.selected.includes(id.replace(/^memory:/, '')), hovered = this.state.hover === id.replace(/^memory:/, '')
      if (!entity.model.startsWith('wall') && !entity.ghost) { entity.outline.visible = selected || hovered; (entity.outline.material as THREE.LineBasicMaterial).opacity = selected ? 1 : .55 }
      entity.appearance.selected = selected; this.repaint(entity)
    }
    if (key === this.controlKey) return
    this.controlKey = key; this.clearGroup(this.controlGroup)
    for (const selected of this.state.selected) {
      const pad = this.map.pads.find(p => p.id === selected)
      if (pad) this.controlGroup.add(circle(pad.x, pad.z, 1.3, '#ffffff', .12))
    }
    if (this.state.preview) {
      const pad = this.map.pads.find(p => p.id === this.state.preview!.padId)
      if (pad) {
        const color = previewOption?.ok ? '#8ed6a0' : '#f06b66'
        this.controlGroup.add(rectangleMesh(pad.rect, .12, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .3, depthWrite: false }), .06))
        this.controlGroup.add(circle(pad.x, pad.z, pad.kind === 'bridge' ? 2.5 : 1.35, color, .18, true))
      }
    }
    if (this.view.mode === 'tutorial') for (const [index, point] of (this.state.focus ?? []).entries()) {
      const marker = circle(point.x, point.z, .95, '#fff1a0', .20, true)
      ;(marker.material as THREE.LineDashedMaterial).opacity = 1; this.controlGroup.add(marker)
      this.controlGroup.add(line([{ x: point.x - .30, z: point.z }, { x: point.x + .30, z: point.z }], '#fff1a0', .21))
      this.controlGroup.add(line([{ x: point.x, z: point.z - .30 }, { x: point.x, z: point.z + .30 }], '#fff1a0', .21))
      const label = sprite(String(index + 1), '#fff1a0', .72); label.position.set(point.x, .65, point.z); this.controlGroup.add(label)
    }
  }
  private updateHazards(): void {
    if (!this.view) return
    const key = JSON.stringify([this.view.matchId, this.view.you, this.view.yourTeam, this.view.operation, this.view.smokes.map(smoke => [smoke.id, smoke.x, smoke.z, smoke.radius]), this.view.barriers.map(barrier => [barrier.id, barrier.team, barrier.a.x, barrier.a.z, barrier.b.x, barrier.b.z])])
    if (key === this.hazardKey) return
    this.hazardKey = key; this.clearGroup(this.hazardGroup)
    for (const smoke of this.view.smokes) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(smoke.radius, smoke.radius, .18, this.settings.quality === 'low' ? 24 : 40), new THREE.MeshBasicMaterial({ color: '#acbab7', transparent: true, opacity: .36, depthWrite: false }))
      mesh.position.set(smoke.x, .5, smoke.z); this.hazardGroup.add(mesh); this.hazardGroup.add(circle(smoke.x, smoke.z, smoke.radius, '#d9e0d5', .60))
    }
    for (const barrier of this.view.barriers) {
      const length = Math.hypot(barrier.b.x - barrier.a.x, barrier.b.z - barrier.a.z)
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, 1.1, .045), new THREE.MeshBasicMaterial({ color: COLORS[barrier.team], transparent: true, opacity: .35, depthWrite: false }))
      mesh.position.set((barrier.a.x + barrier.b.x) / 2, .55, (barrier.a.z + barrier.b.z) / 2); mesh.rotation.y = -Math.atan2(barrier.b.z - barrier.a.z, barrier.b.x - barrier.a.x); this.hazardGroup.add(mesh)
      this.hazardGroup.add(line([barrier.a, barrier.b], COLORS[barrier.team], 1.10))
    }
  }
  private updateAim(): void {
    const fighter = this.view?.units.find(u => u.ownerId === this.view!.you && u.kind === 'fighter')
    const own = this.view?.participants.find(p => p.id === this.view!.you)
    this.aimGroup.visible = !!(this.state.aim && fighter && own?.mode === 'fighter')
    if (!this.state.aim || !fighter || !this.aimGroup.visible) return
    const rendered = this.entities.get(fighter.id)?.group.position, x = rendered?.x ?? fighter.x, z = rendered?.z ?? fighter.z
    const length = Math.min(12, Math.hypot(this.state.aim.x - x, this.state.aim.z - z)), angle = Math.atan2(this.state.aim.z - z, this.state.aim.x - x)
    const positions = this.aimLine.geometry.getAttribute('position') as THREE.BufferAttribute
    positions.setXYZ(0, x, .15, z); positions.setXYZ(1, x + Math.cos(angle) * length, .15, z + Math.sin(angle) * length); positions.needsUpdate = true; this.aimLine.geometry.computeBoundingSphere()
    this.aimMarker.position.set(this.state.aim.x, 0, this.state.aim.z)
  }
  private updateCamera(dt: number): void {
    if (this.qaTiming) this.qaCameraLayoutReadMs = 0
    if (!this.map) return
    const layoutReadStart = this.qaTiming ? performance.now() : 0
    const rect = this.host.getBoundingClientRect()
    if (this.qaTiming) this.qaCameraLayoutReadMs = performance.now() - layoutReadStart
    const aspect = Math.max(.3, rect.width / Math.max(1, rect.height)), own = this.view?.participants.find(p => p.id === this.view!.you), tactics = own?.mode === 'tactics'
    const fighter = this.view?.units.find(u => u.ownerId === this.view!.you && u.kind === 'fighter'), target = tactics ? this.state.target ?? { x: this.map.width / 2, z: this.map.height / 2 } : this.prediction ?? fighter ?? this.map.bases[this.view?.teams[this.view.yourTeam].side ?? 'L']
    const width = tactics ? Math.max(this.map.width + 5, (this.map.height * SQRT3_2 + 5) * aspect) / this.state.zoom : (rect.width < 600 ? 24 : 38) / this.state.zoom
    const halfH = width / aspect / 2; this.camera.left = -width / 2; this.camera.right = width / 2; this.camera.top = halfH; this.camera.bottom = -halfH; this.camera.updateProjectionMatrix()
    const wanted = new THREE.Vector3(THREE.MathUtils.clamp(target.x, width < this.map.width ? width / 2 : this.map.width / 2, width < this.map.width ? this.map.width - width / 2 : this.map.width / 2), 0, THREE.MathUtils.clamp(target.z, Math.min(halfH / SQRT3_2, this.map.height / 2), Math.max(this.map.height - halfH / SQRT3_2, this.map.height / 2)))
    this.center.lerp(wanted, this.settings.reducedMotion ? 1 : Math.min(1, dt / .12)); this.camera.position.copy(this.center).add(new THREE.Vector3(0, 30, 17.320508)); this.camera.lookAt(this.center)
  }
  private fadeOccluders(): void {
    if (!this.view) return
    const targets = [...this.view.units.filter(u => u.kind === 'fighter').map(u => ({ x: this.entities.get(u.id)?.group.position.x ?? u.x, z: this.entities.get(u.id)?.group.position.z ?? u.z, y: .8, radius: .32 })), ...this.view.transports.map(t => ({ x: t.x, z: t.z, y: .9, radius: .8 }))]
    for (const [id, entity] of this.entities) {
      const rect = entity.occluder
      if (!rect || !entity.object || entity.ghost) continue
      const fade = targets.some(t => t.x + t.radius >= rect.x1 && t.x - t.radius <= rect.x2 && rect.z2 > t.z && t.y * .5 - t.z * SQRT3_2 >= -rect.z2 * SQRT3_2 && t.y * .5 - t.z * SQRT3_2 <= rect.height * .5 - rect.z1 * SQRT3_2)
      if (fade === entity.faded) continue
      entity.faded = fade
      entity.object.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          if (!(material instanceof THREE.MeshStandardMaterial) || material.name.startsWith('FP_Concrete')) continue
          // The actual collision base remains outlined even with low-profile vertex-colour batching.
          material.transparent = fade; material.opacity = fade ? .35 : 1; material.depthWrite = !fade
        }
      })
      entity.outline.visible = !entity.model.startsWith('wall') && (this.state.selected.includes(id) || this.state.hover === id)
      if (entity.collisionOutline) entity.collisionOutline.visible = fade
    }
  }
  private frame = (time: number): void => {
    if (this.destroyed) return
    const qa = this.qaTiming, callbackStart = qa ? performance.now() : 0
    const dt = Math.min(.1, (time - this.previousTime) / 1000); this.previousTime = time
    const own = this.view?.participants.find(p => p.id === this.view!.you), fighter = this.view?.units.find(u => u.ownerId === this.view!.you && u.kind === 'fighter')
    const prediction = own?.mode === 'fighter' && fighter ? this.options.getPrediction?.() ?? null : null
    this.prediction = prediction && prediction.id === fighter?.id && Number.isFinite(prediction.x + prediction.z + prediction.angle) ? prediction : null
    const cameraStart = qa ? performance.now() : 0
    this.updateCamera(dt)
    const entitiesStart = qa ? performance.now() : 0
    const fresh = time - this.lastViewAt < 250
    for (const [id, entity] of this.entities) {
      const predicted = this.prediction?.id === id ? this.prediction : null, targetX = predicted?.x ?? entity.lastX, targetZ = predicted?.z ?? entity.lastZ
      const x = entity.group.position.x, z = entity.group.position.z, t = this.settings.reducedMotion || Math.hypot(targetX - x, targetZ - z) > 3 ? 1 : 1 - Math.exp(-dt / (predicted ? .04 : .075))
      entity.group.position.x += (targetX - x) * t; entity.group.position.z += (targetZ - z) * t; entity.distance += Math.hypot(entity.group.position.x - x, entity.group.position.z - z)
      if (predicted) entity.group.rotation.y = -predicted.angle - Math.PI / 2
      this.inverseRotation.copy(entity.group.quaternion).invert(); entity.hp.quaternion.copy(this.camera.quaternion).premultiply(this.inverseRotation); entity.progress.quaternion.copy(entity.hp.quaternion)
      if (entity.object) animateForpostModel(entity.object, { ...entity.animation, time: (this.view?.tick ?? 0) / 30 + Math.min(.1, Math.max(0, time - this.lastViewAt) / 1000), moving: fresh && (predicted ? Math.hypot(entity.group.position.x - x, entity.group.position.z - z) > .001 : !!entity.animation.moving), working: fresh && !!entity.animation.working, distance: entity.distance, sinceHit: typeof entity.group.userData.hitAt === 'number' ? (time - entity.group.userData.hitAt) / 1000 : undefined, sinceShot: typeof entity.group.userData.shotAt === 'number' ? (time - entity.group.userData.shotAt) / 1000 : undefined, reducedMotion: this.settings.reducedMotion })
    }
    const effectsStart = qa ? performance.now() : 0
    this.fadeOccluders(); this.updateAim()
    for (const effect of this.effects) if (time >= effect.until) { this.disposeObject(effect.object); this.effectGroup.remove(effect.object) }
    this.effects = this.effects.filter(e => time < e.until)
    for (const retiring of this.retiring) {
      const progress = Math.min(1, (time - retiring.start) / retiring.duration)
      retiring.entity.hp.visible = false; retiring.entity.progress.visible = false; retiring.entity.outline.visible = false; if (retiring.entity.label) retiring.entity.label.visible = false
      if (retiring.entity.object) animateForpostModel(retiring.entity.object, { time: time / 1000, destroyProgress: progress, reducedMotion: this.settings.reducedMotion })
      if (progress >= 1) {
        if (!this.settings.reducedMotion) {
          const rubble = new THREE.Mesh(new THREE.OctahedronGeometry(.16, 0), new THREE.MeshStandardMaterial({ color: '#64736b', roughness: 1 }))
          rubble.scale.set(2.6, .35, 1.2); rubble.position.copy(retiring.entity.group.position); rubble.position.y = .06
          this.effectGroup.add(rubble); this.effects.push({ object: rubble, until: time + 2000 })
        }
        this.clearGroup(retiring.entity.group); this.entityGroup.remove(retiring.entity.group)
      }
    }
    this.retiring = this.retiring.filter(r => time - r.start < r.duration)
    const renderStart = performance.now()
    this.renderer.render(this.scene, this.camera)
    const renderEnd = performance.now()
    this.renderWallTimes[this.frames % this.renderWallTimes.length] = renderEnd - renderStart
    this.frames++; this.raf = requestAnimationFrame(this.frame)
    if (qa) {
      qa.timestampAgeMs.record(callbackStart - time)
      qa.cameraWallMs.record(entitiesStart - cameraStart)
      qa.cameraLayoutReadMs.record(this.qaCameraLayoutReadMs)
      qa.entityAnimationWallMs.record(effectsStart - entitiesStart)
      qa.effectsWallMs.record(renderStart - effectsStart)
      qa.renderSubmitWallMs.record(renderEnd - renderStart)
      // Stops at the end of the callback body, before this final ring write.
      // It never waits for GPU completion or includes a subsequent browser paint.
      qa.callbackWallMs.record(performance.now() - callbackStart)
    }
  }
  setSettings(settings: Settings): void {
    const qualityChanged = settings.quality !== this.settings.quality
    this.settings = settings; this.renderer.shadowMap.enabled = settings.quality !== 'low'; this.renderer.setPixelRatio(Math.min(devicePixelRatio, settings.quality === 'low' ? 1 : 1.75))
    if (qualityChanged && this.view) { this.mapKey = ''; this.setView(this.view) }
  }
  setState(state: StageState): void {
    const start = this.qaTiming ? performance.now() : 0
    this.state = { ...state, focus: state.focus ?? [] }; this.updateControls(); this.updateNetwork(); this.updateAim()
    if (this.qaTiming) this.qaTiming.setStateSyncCallWallMs.record(performance.now() - start)
  }
  worldPoint(clientX: number, clientY: number): Point {
    const rect = this.host.getBoundingClientRect(); this.raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), this.camera)
    const target = new THREE.Vector3(); this.raycaster.ray.intersectPlane(this.plane, target); return { x: target.x, z: target.z }
  }
  metrics(): StageMetrics {
    const times = Array.from(this.renderWallTimes.subarray(0, Math.min(this.frames, this.renderWallTimes.length))).sort((a, b) => a - b)
    const result: StageMetrics = { frames: this.frames, elapsed: performance.now() - this.started, drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, renderWall: { samples: times.length, p50Ms: times[Math.ceil(times.length * .5) - 1] ?? 0, p95Ms: times[Math.ceil(times.length * .95) - 1] ?? 0, maxMs: times.at(-1) ?? 0 } }
    if (this.qaTiming) result.qaPhases = {
      ...Object.fromEntries(Object.entries(this.qaTiming).map(([key, ring]) => [key, ring.summary()])) as Record<QaPhaseName, QaTimingSummary>,
      windowSize: QA_TIMING_WINDOW,
      coverage: { samples: 'totalMs and percentiles cover the retained window; observations counts all calls', sceneUpdates: 'completed synchronous Scene calls only; excludes React render/commit and async model completion', nestedPhase: 'cameraLayoutReadMs is included in cameraWallMs', scheduling: 'timestampAgeMs and frame gaps overlap scheduling; do not add them to callback phases', reactRenderAndCommit: 'not-measured', asyncModelLoading: 'not-measured', gpuCompletion: 'not-measured' },
    }
    return result
  }
  private disposeObject(object: THREE.Object3D): void {
    object.traverse(child => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.Sprite) {
        if ('geometry' in child && !child.userData.forpostSharedGeometry) child.geometry.dispose()
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          const texture = (material as THREE.MeshBasicMaterial).map
          if (texture && texture !== this.fogTexture && !child.userData.forpostSharedGeometry) texture.dispose()
          material.dispose()
        }
      }
    })
  }
  private clearGroup(group: THREE.Group): void { for (const child of [...group.children]) { this.disposeObject(child); group.remove(child) } }
  destroy(): void {
    this.destroyed = true; cancelAnimationFrame(this.raf); this.resize.disconnect(); this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost)
    for (const group of [this.mapGroup, this.entityGroup, this.networkGroup, this.controlGroup, this.hazardGroup, this.effectGroup, this.aimGroup]) this.clearGroup(group)
    for (const promise of this.models.values()) void promise.then(model => model.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose() } })).catch(() => {})
    this.fogTexture.dispose(); this.renderer.dispose(); this.renderer.domElement.remove()
  }
}
