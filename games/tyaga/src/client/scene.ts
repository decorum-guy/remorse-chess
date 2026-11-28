import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { EntityView, ItemKind, TyagaView, Vec3, WheelView } from '../core/types';
import { BODY } from '../core/config';
import { TerrainMaterials, terrainUVs } from './terrain-materials';
import { ContactShadow } from './contact-shadow';

const COLORS = ['#D97736', '#37BCD0', '#EBC75A', '#8160A4', '#D85E76', '#397D68'];
const base = import.meta.env.BASE_URL + 'assets/tyaga/models/';
type Resource = THREE.Material | THREE.BufferGeometry | THREE.Texture;
type WheelNode = { spin: THREE.Object3D; steering: THREE.Object3D; index: number };
type Dynamic = {
  root: THREE.Group; model: string; entity: EntityView; generation: number;
  modelRoot?: THREE.Object3D; mixer?: THREE.AnimationMixer; clips?: Map<string, THREE.AnimationClip>; current?: string;
  materials: Set<THREE.Material>; skeletons: Set<THREE.Skeleton>; wheels: WheelNode[];
  appearanceKey?: string; accessories: THREE.Object3D[]; marker?: THREE.Sprite; damageUntil: number;
};
type CableVisual = { mesh: THREE.InstancedMesh; material: THREE.MeshStandardMaterial; warning: THREE.Sprite; capacity: number; kind: string };
type Particle = { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number; duration: number };
export interface SceneOptions { quality: 'high' | 'low'; reducedMotion: boolean; showSockets: boolean; flashes: boolean; shake: number }
export interface PlacementPreview { kind: ItemKind; position: Vec3; angle: number }

function collectResources(object: THREE.Object3D, into: Set<Resource>) {
  object.traverse(node => {
    if (!(node instanceof THREE.Mesh) && !(node instanceof THREE.Line) && !(node instanceof THREE.Sprite)) return;
    if ('geometry' in node) into.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      into.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) into.add(value);
    }
  });
}
function disposeResources(resources: Set<Resource>) { for (const resource of resources) resource.dispose(); resources.clear(); }
function visibleInScene(object: THREE.Object3D) { for (let parent: THREE.Object3D | null = object; parent; parent = parent.parent) if (!parent.visible) return false; return true; }
function canvasTexture(draw: (context: CanvasRenderingContext2D, size: number) => void, size = 128) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const context = canvas.getContext('2d'); if (!context) throw new Error('CANVAS_UNAVAILABLE');
  draw(context, size); const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
function crewTexture(seat: number, bot: boolean) {
  return canvasTexture((c, size) => {
    const cx = size / 2, cy = size / 2, radius = size * .37;
    c.lineWidth = size * .065; c.strokeStyle = '#F5F7F2'; c.fillStyle = COLORS[seat % 6]; c.beginPath();
    const sides = [0, 4, 3, 4, 5, 6][seat % 6];
    if (!sides) c.arc(cx, cy, radius, 0, Math.PI * 2);
    else for (let i = 0; i <= sides; i++) { const angle = i / sides * Math.PI * 2 - Math.PI / 2 + (seat % 6 === 3 ? Math.PI / 4 : 0); const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius; if (!i) c.moveTo(x, y); else c.lineTo(x, y); }
    c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#243B45'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = 'bold 48px "Golos Text", sans-serif'; c.fillText(bot ? 'B' : String(seat + 1), cx, cy + 3);
  });
}

export class TyagaScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera();
  readonly ground = new THREE.Group();
  readonly actors = new THREE.Group();
  readonly connections = new THREE.Group();
  readonly markers = new THREE.Group();
  readonly socketMarkers = new THREE.Group();
  private effects = new THREE.Group();
  private placementRoot = new THREE.Group();
  private placement: PlacementPreview | null = null;
  private placementGeneration = 0;
  private placementMaterial = new THREE.MeshBasicMaterial({ color: '#37bcd0', opacity: .42, transparent: true, depthWrite: false });
  private clock = new THREE.Clock();
  private frame = 0;
  private view: TyagaView | null = null;
  private frames: { time: number; view: TyagaView }[] = [];
  private dynamics = new Map<string, Dynamic>();
  private assets = new Map<string, Promise<GLTF>>();
  private resources = new Set<Resource>();
  private mapResources = new Set<Resource>();
  private cables = new Map<string, CableVisual>();
  private sockets = new Map<string, THREE.Mesh>();
  private particles: Particle[] = [];
  private mapGeneration = 0;
  private mapId = '';
  private selectedId: string | null = null;
  private selectionRing = new THREE.Mesh(new THREE.TorusGeometry(.6, .035, 6, 40), new THREE.MeshBasicMaterial({ color: '#37BCD0', depthTest: false, depthWrite: false }));
  private heightLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: '#344955', dashSize: .13, gapSize: .09, depthTest: false, transparent: true, opacity: .65 }));
  private contactShadows = Array.from({ length: 2 }, () => new ContactShadow(resource => this.resources.add(resource)));
  private socketGeometry = new THREE.SphereGeometry(.09, 8, 6);
  private socketFree = new THREE.MeshBasicMaterial({ color: '#37BCD0', depthTest: false, depthWrite: false });
  private socketOccupied = new THREE.MeshBasicMaterial({ color: '#D97736', depthTest: false, depthWrite: false });
  private ropeGeometry = new THREE.CylinderGeometry(1, 1, 1, 7, 1);
  private strapGeometry = new THREE.BoxGeometry(1, 1, 1);
  private particleGeometry = new THREE.IcosahedronGeometry(.06, 0);
  private particleMaterial = new THREE.MeshStandardMaterial({ color: '#c5af82', roughness: .96 });
  private warningMaterial: THREE.SpriteMaterial;
  private crewMaterials = new Map<string, THREE.SpriteMaterial>();
  private waterNormal: THREE.DataTexture;
  private faded = new Map<THREE.Material, { opacity: number; transparent: boolean; depthWrite: boolean }>();
  private focus = new THREE.Vector3();
  private firstFocus = true;
  private width = 1;
  private height = 1;
  private zoom = 1;
  private options: SceneOptions = { quality: 'high', reducedMotion: false, showSockets: false, flashes: true, shake: .4 };
  private observer: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private disposed = false;
  private lastEventId: number | null = null;
  private shakeUntil = 0;
  private shakeStrength = 0;
  private pointerStarts = new Map<number, { startX: number; startY: number; x: number; y: number; pinched: boolean }>();
  private pinchStart: { distance: number; zoom: number } | null = null;
  onSelect: (id: string | null, point?: Vec3) => void = () => {};
  onContextLost: () => void = () => {};
  onError: (message: string) => void = () => {};
  onPlacementPoint: (point: Vec3) => void = () => {};

  constructor(readonly container: HTMLElement) {
    // Occlusion and support rays also visit the camera-facing crew sprites.
    // A world-space Raycaster.set() does not set this camera as setFromCamera does.
    this.raycaster.camera = this.camera;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.25;
    this.renderer.domElement.setAttribute('aria-label', 'Трёхмерный мир экспедиции / Expedition world'); this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color('#dce8e4'); this.scene.fog = new THREE.Fog('#dce8e4', 80, 190);
    this.scene.add(new THREE.HemisphereLight('#eff7ef', '#7c8a70', 2.8));
    const sun = new THREE.DirectionalLight('#fff4d6', 3.4); sun.position.set(-25, 48, 20); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -35; sun.shadow.camera.right = 35; sun.shadow.camera.top = 35; sun.shadow.camera.bottom = -35; sun.shadow.camera.far = 150; sun.shadow.normalBias = .025; sun.shadow.bias = -.00015;
    sun.name = 'sun'; this.scene.add(sun, sun.target);
    this.scene.add(this.ground, this.actors, this.connections, this.markers, this.socketMarkers, this.effects, this.placementRoot);
    this.resources.add(this.placementMaterial);
    this.selectionRing.rotation.x = -Math.PI / 2; this.selectionRing.renderOrder = 5; this.selectionRing.visible = false; this.heightLine.renderOrder = 6; this.heightLine.visible = false;
    this.scene.add(this.selectionRing, this.heightLine); collectResources(this.selectionRing, this.resources); collectResources(this.heightLine, this.resources);
    for (const shadow of this.contactShadows) this.scene.add(shadow.mesh);
    const warning = canvasTexture((c, size) => { c.fillStyle = '#EBC75A'; c.strokeStyle = '#344955'; c.lineWidth = 8; c.beginPath(); c.moveTo(size / 2, 9); c.lineTo(size - 9, size - 13); c.lineTo(9, size - 13); c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#344955'; c.textAlign = 'center'; c.font = 'bold 72px sans-serif'; c.fillText('!', size / 2, 99); });
    this.warningMaterial = new THREE.SpriteMaterial({ map: warning, depthTest: false, depthWrite: false });
    const normalBytes = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 4; normalBytes[i] = 128 + Math.round(20 * Math.sin(x / 64 * Math.PI * 6 + Math.cos(y / 64 * Math.PI * 4))); normalBytes[i + 1] = 128 + Math.round(17 * Math.cos(y / 64 * Math.PI * 8 + Math.sin(x / 64 * Math.PI * 4))); normalBytes[i + 2] = 250; normalBytes[i + 3] = 255; }
    this.waterNormal = new THREE.DataTexture(normalBytes, 64, 64); this.waterNormal.wrapS = this.waterNormal.wrapT = THREE.RepeatWrapping; this.waterNormal.repeat.set(6, 6); this.waterNormal.needsUpdate = true;
    for (const resource of [this.socketGeometry, this.socketFree, this.socketOccupied, this.ropeGeometry, this.strapGeometry, this.particleGeometry, this.particleMaterial, this.warningMaterial, warning, this.waterNormal]) this.resources.add(resource);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container); this.resize();
    const canvas = this.renderer.domElement;
    canvas.addEventListener('wheel', this.onWheel, { passive: false }); canvas.addEventListener('pointerdown', this.onDown); canvas.addEventListener('pointermove', this.onMove); canvas.addEventListener('pointerup', this.onUp); canvas.addEventListener('pointercancel', this.onCancel); canvas.addEventListener('lostpointercapture', this.onPointerLost); canvas.addEventListener('webglcontextlost', this.onLost); canvas.addEventListener('webglcontextrestored', this.onRestored);
    window.addEventListener('blur', this.onCancel); this.tick();
  }

  suggestPlacement(kind: ItemKind, point?: Vec3): { position: Vec3; supported: boolean; withinReach: boolean } {
    const self = this.view?.participants.find(p => p.participantId === this.view?.participantId);
    const person = this.view?.entities.find(e => e.id === self?.entityId), crate = this.view?.entities.find(e => e.id === 'equipment-crate');
    const actor = person?.position ?? { x: 0, y: 0, z: 0 };
    const away = new THREE.Vector3(actor.x - (crate?.position.x ?? actor.x - 1), 0, actor.z - (crate?.position.z ?? actor.z));
    if (away.lengthSq() < .001) away.set(1, 0, 0); away.normalize().multiplyScalar(1.15);
    const proposed = point ?? { x: actor.x + away.x, y: actor.y, z: actor.z + away.z };
    this.scene.updateMatrixWorld(true);
    this.raycaster.set(new THREE.Vector3(proposed.x, proposed.y + 2, proposed.z), new THREE.Vector3(0, -1, 0)); this.raycaster.far = 6;
    const support = this.raycaster.intersectObjects([this.ground, this.actors], true).find(hit => {
      const entity = this.dynamics.get(hit.object.userData.entityId)?.entity;
      return hit.object instanceof THREE.Mesh && visibleInScene(hit.object) && !hit.object.userData.decor &&
        (hit.object.userData.surface || (entity && entity.kind !== 'character' && entity.kind !== 'rope-segment'));
    });
    this.raycaster.far = Infinity;
    const size = kind === 'deck' ? { x: 1.5, y: .4, z: 1.5 } : BODY[kind].size;
    const position = { x: proposed.x, y: support ? support.point.y + size.y / 2 + .04 : proposed.y, z: proposed.z };
    // This is a visual suggestion. The authoritative unpack action checks exact
    // collision geometry and crate reach again before creating a physical item.
    return { position, supported: !!support, withinReach: !!person && Math.hypot(position.x - actor.x, position.y - actor.y, position.z - actor.z) <= 2 };
  }
  setPlacementPreview(value: PlacementPreview | null) {
    const oldKind = this.placement?.kind; this.placement = value;
    if (!value) { this.placementGeneration++; this.placementRoot.clear(); this.placementRoot.visible = false; return; }
    this.placementRoot.visible = true; this.placementRoot.position.set(value.position.x, value.position.y, value.position.z); this.placementRoot.rotation.y = value.angle;
    const check = this.suggestPlacement(value.kind, value.position); this.placementMaterial.color.set(check.supported && check.withinReach ? '#37bcd0' : '#d97736');
    if (oldKind === value.kind && this.placementRoot.children.length) return;
    const generation = ++this.placementGeneration; this.placementRoot.clear();
    void this.asset(value.kind === 'deck' ? 'deck-folded' : BODY[value.kind].model).then(gltf => {
      if (this.disposed || this.placementGeneration !== generation || this.placement?.kind !== value.kind) return;
      const model = gltf.scene.clone(true);
      model.traverse(node => { if (node instanceof THREE.Mesh) { node.material = this.placementMaterial; node.castShadow = false; node.receiveShadow = false; } });
      this.placementRoot.add(model);
    }).catch(() => { if (!this.disposed && this.placementGeneration === generation) this.onError('MODEL_UNAVAILABLE'); });
  }

  private material(color: string, metalness = 0, roughness = .85) { const material = new THREE.MeshStandardMaterial({ color, metalness, roughness }); this.mapResources.add(material); return material; }
  private mesh(geometry: THREE.BufferGeometry, material: THREE.Material, position?: Vec3) {
    this.mapResources.add(geometry); this.mapResources.add(material); const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true;
    if (position) mesh.position.set(position.x, position.y, position.z); return mesh;
  }
  private asset(model: string) {
    let pending = this.assets.get(model);
    if (!pending) {
      pending = new GLTFLoader().loadAsync(base + model + '.glb').then(gltf => {
        const loaded = new Set<Resource>(); collectResources(gltf.scene, loaded);
        if (this.disposed) disposeResources(loaded); else for (const resource of loaded) this.resources.add(resource);
        return gltf;
      }).catch(error => { if (this.assets.get(model) === pending) this.assets.delete(model); throw error; });
      this.assets.set(model, pending);
    }
    return pending;
  }
  setOptions(options: SceneOptions) {
    const changedQuality = options.quality !== this.options.quality;
    this.options = { ...options, shake: THREE.MathUtils.clamp(options.shake, 0, 1) }; this.renderer.shadowMap.enabled = options.quality !== 'low';
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.quality === 'low' ? 1 : 1.75)); this.socketMarkers.visible = options.showSockets; this.resize();
    if (changedQuality && this.view) this.buildMap(this.view);
    if (options.reducedMotion || !options.shake) this.shakeUntil = 0;
  }
  setSelection(id: string | null) { this.selectedId = id; }
  setZoom(amount: number) { this.zoom = THREE.MathUtils.clamp(amount, .75, 1.6); this.resize(); }
  private resize() {
    const box = this.container.getBoundingClientRect(); this.width = Math.max(1, box.width); this.height = Math.max(1, box.height);
    const ratio = this.width / this.height, mobile = this.width < 900;
    const visibleHeight = Math.max(mobile ? ratio > 1 ? 14 : 24 : 18, 13 / ratio) / this.zoom;
    this.camera.left = -visibleHeight * ratio / 2; this.camera.right = visibleHeight * ratio / 2; this.camera.top = visibleHeight / 2; this.camera.bottom = -visibleHeight / 2; this.camera.near = .1; this.camera.far = 400; this.camera.updateProjectionMatrix(); this.renderer.setSize(this.width, this.height);
  }
  private clear(group: THREE.Group) { for (const child of [...group.children]) group.remove(child); }
  private restoreOccluders() {
    for (const [material, original] of this.faded) { Object.assign(material, original); material.needsUpdate = true; }
    this.faded.clear();
  }
  private buildMap(view: TyagaView) {
    this.mapGeneration++; this.restoreOccluders(); this.clear(this.ground); this.clear(this.markers); disposeResources(this.mapResources);
    const map = view.map, background = view.mapId === 'ridge' ? '#dae3e8' : view.mapId === 'quarry' ? '#c9dddd' : '#dce8e4';
    this.scene.background = new THREE.Color(background); (this.scene.fog as THREE.Fog).color.set(background);
    const terrain = new TerrainMaterials(view.mapId, this.options.quality === 'low', Math.min(this.renderer.capabilities.getMaxAnisotropy(), this.options.quality === 'low' ? 2 : 4), resource => this.mapResources.add(resource));
    for (const surface of map.surfaces) {
      const material = terrain.material(surface);
      let geometry: THREE.BufferGeometry;
      if (surface.mesh) {
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(surface.mesh.vertices, 3));
        geometry.setIndex(surface.mesh.indices);
        // Independent face UVs avoid stretching top textures down the cliff.
        // The triangle positions and authoritative collision mesh are unchanged.
        const faces = geometry.toNonIndexed(); geometry.dispose(); geometry = faces; geometry.computeVertexNormals();
      } else geometry = new THREE.BoxGeometry(surface.size.x, surface.size.y, surface.size.z);
      terrainUVs(geometry, surface);
      const object = this.mesh(geometry, material, surface.position);
      object.quaternion.set(surface.rotation.x, surface.rotation.y, surface.rotation.z, surface.rotation.w); object.userData.surface = true; object.userData.surfaceId = surface.id; this.ground.add(object);
      // Every solid surface, including the lower rock strata, comes from the same
      // public collision definition used by the authoritative world.
      const render = surface as typeof surface & { renderModel?: string; renderPosition?: Vec3 };
      if (render.renderModel) this.addScenery(render.renderModel, render.renderPosition ?? surface.position, 1, 0, false, object);
    }
    for (const zone of [...map.checkpoints, map.finish]) {
      const finish = zone.id === map.finish.id, color = finish ? '#D97736' : '#37BCD0';
      const patch = this.mesh(new THREE.PlaneGeometry(zone.size.x, zone.size.z), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .10, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }), { x: zone.position.x, y: zone.position.y + .025, z: zone.position.z });
      patch.rotation.x = -Math.PI / 2; patch.castShadow = false; this.markers.add(patch);
      const points = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([x, z]) => new THREE.Vector3(x * zone.size.x / 2, 0, z * zone.size.z / 2));
      const geometry = new THREE.BufferGeometry().setFromPoints(points), material = new THREE.LineDashedMaterial({ color, dashSize: .65, gapSize: .45, transparent: true, opacity: .8 }); this.mapResources.add(geometry); this.mapResources.add(material);
      const outline = new THREE.Line(geometry, material); outline.computeLineDistances(); outline.position.set(zone.position.x, zone.position.y + .035, zone.position.z); this.markers.add(outline);
    }
    for (const water of map.waterVolumes) {
      const material = new THREE.MeshStandardMaterial({ color: view.mapId === 'quarry' ? '#419da8' : '#54b3bb', roughness: .25, metalness: .18, transparent: true, opacity: .78, normalMap: this.waterNormal, normalScale: new THREE.Vector2(.24, .24), depthWrite: false });
      const plane = this.mesh(new THREE.PlaneGeometry(water.max.x - water.min.x, water.max.z - water.min.z), material, { x: (water.max.x + water.min.x) / 2, y: view.weather.waterLevel ?? water.baseLevel, z: (water.max.z + water.min.z) / 2 });
      plane.rotation.x = -Math.PI / 2; plane.name = 'water'; plane.castShadow = false; plane.userData.base = water.baseLevel; plane.userData.decor = true; plane.renderOrder = 1; this.ground.add(plane);
    }
    const floor = this.mesh(new THREE.PlaneGeometry(map.bounds.x + 200, map.bounds.z + 200), this.material(view.mapId === 'quarry' ? '#759b9e' : '#92ada0'), { x: map.bounds.x / 2, y: map.abyssY - 2, z: map.bounds.z / 2 }); floor.rotation.x = -Math.PI / 2; floor.castShadow = false; floor.userData.decor = true; this.ground.add(floor);
    this.decorate(view); this.mapId = map.id + map.version;
  }
  private addScenery(model: string, position: Vec3, scale: number, yaw: number, decor = true, collider?: THREE.Object3D) {
    const generation = this.mapGeneration;
    void this.asset(model).then(gltf => {
      if (this.disposed || generation !== this.mapGeneration) return;
      const object = gltf.scene.clone(true); object.position.set(position.x, position.y, position.z); object.scale.setScalar(scale); object.rotation.y = yaw;
      object.traverse(node => { node.userData.decor = decor; if (!decor) node.userData.surface = true; if (node instanceof THREE.Mesh) { node.castShadow = true; node.receiveShadow = true; } });
      this.ground.add(object); if (collider) { collider.userData.renderObject = object; collider.visible = false; }
      if (model === 'camp' && collider) {
        const id = String(collider.userData.surfaceId).replace(/^camp-board-/, '');
        for (const other of this.ground.children) if (String(other.userData.surfaceId).startsWith(`camp-post-${id}-`) || String(other.userData.surfaceId).startsWith(`camp-box-${id}-`)) other.visible = false;
      }
    }).catch(() => { if (collider && !this.disposed && generation === this.mapGeneration) { collider.visible = true; this.onError('MODEL_UNAVAILABLE'); } });
  }
  private decorate(view: TyagaView) {
    const map = view.map, count = this.options.quality === 'low' ? 12 : 28;
    // These are a backdrop: their complete footprints lie outside map bounds and
    // below the rescue plane. Playable obstructions use collision-backed surfaces.
    for (let i = 0; i < count; i++) {
      const x = -12 + (i / Math.max(1, count - 1)) * (map.bounds.x + 24), near = i % 2 === 0, z = near ? -11 - i % 4 * 3 : map.bounds.z + 11 + i % 4 * 3;
      const scale = view.mapId === 'ridge' ? 2.8 + i % 3 : 1.5 + i % 3 * .6;
      this.addScenery(`rock-${['a', 'b', 'c'][i % 3]}`, { x, y: map.abyssY - 2, z }, scale, i * 2.4);
      if (view.mapId !== 'ridge' || i % 3 === 0) this.addScenery(i % 4 === 1 ? 'tree-birch' : 'tree-pine', { x: x + 3, y: map.abyssY - 2, z: z + (near ? -5 : 5) }, 1.2 + i % 3 * .3, i);
    }
  }

  private cloneForDynamic(source: THREE.Object3D, dynamic: Dynamic) {
    const object = clone(source), materialCopies = new Map<THREE.Material, THREE.Material>();
    object.traverse(node => {
      node.userData.entityId = dynamic.entity.id;
      if (node instanceof THREE.Mesh) {
        node.castShadow = true; node.receiveShadow = true;
        const copy = (material: THREE.Material) => {
          let next = materialCopies.get(material);
          if (!next) { next = material.clone(); materialCopies.set(material, next); dynamic.materials.add(next);
            if (next instanceof THREE.MeshStandardMaterial) { next.userData.originalEmissive = next.emissive.clone(); next.userData.originalColor = next.color.clone(); next.userData.originalRoughness = next.roughness; }
                if (next instanceof THREE.MeshStandardMaterial && dynamic.entity.kind === 'character' && /cloth|jacket|shirt|clothing/i.test(material.name)) { next.color.set(COLORS[(dynamic.entity.seatIndex ?? 0) % 6]); next.userData.originalColor = next.color.clone(); }
          } return next;
        };
        node.material = Array.isArray(node.material) ? node.material.map(copy) : copy(node.material);
        if (node instanceof THREE.SkinnedMesh) dynamic.skeletons.add(node.skeleton);
      }
    }); return object;
  }
  private clearDynamic(dynamic: Dynamic) {
    dynamic.generation++; dynamic.mixer?.stopAllAction(); if (dynamic.modelRoot) dynamic.mixer?.uncacheRoot(dynamic.modelRoot);
    for (const material of dynamic.materials) { this.faded.delete(material); material.dispose(); } dynamic.materials.clear();
    for (const skeleton of dynamic.skeletons) skeleton.dispose(); dynamic.skeletons.clear();
    this.clear(dynamic.root); dynamic.modelRoot = undefined; dynamic.mixer = undefined; dynamic.clips = undefined; dynamic.current = undefined; dynamic.appearanceKey = undefined; dynamic.accessories = []; dynamic.marker = undefined; dynamic.wheels = [];
  }
  private loadDynamic(dynamic: Dynamic) {
    this.clearDynamic(dynamic); const generation = dynamic.generation;
    void this.asset(dynamic.model).then(gltf => {
      if (this.disposed || this.dynamics.get(dynamic.entity.id) !== dynamic || generation !== dynamic.generation) return;
      const model = this.cloneForDynamic(gltf.scene, dynamic); dynamic.modelRoot = model; dynamic.root.add(model);
      if (gltf.animations.length) { dynamic.mixer = new THREE.AnimationMixer(model); dynamic.clips = new Map(gltf.animations.map(clip => [clip.name.toLowerCase(), clip])); }
      if (dynamic.entity.kind === 'truck') model.traverse(node => {
        if (node.name === 'cargo-support-low') node.visible = this.view?.map.cargo[0] !== 'mast';
        if (node.name === 'cargo-support-high') node.visible = this.view?.map.cargo[0] === 'mast';
        const suffix = /^wheel[-_](fl|fr|rl|rr)$/i.exec(node.name)?.[1].toLowerCase();
        if (suffix && node.parent) dynamic.wheels.push({ spin: node, steering: node.parent, index: ['fl', 'fr', 'rl', 'rr'].indexOf(suffix) });
      });
      this.applyAppearance(dynamic); this.updateCrewMarker(dynamic);
    }).catch(() => { if (!this.disposed && this.dynamics.get(dynamic.entity.id) === dynamic && generation === dynamic.generation) this.onError('MODEL_UNAVAILABLE'); });
  }
  private applyAppearance(dynamic: Dynamic) {
    if (dynamic.entity.kind !== 'character' || !dynamic.modelRoot) return;
    const appearance = dynamic.entity.appearance ?? { head: (dynamic.entity.seatIndex ?? 0) % 2, backpack: Math.floor((dynamic.entity.seatIndex ?? 0) / 2) % 2 };
    const key = `${appearance.head}:${appearance.backpack}`; if (dynamic.appearanceKey === key) return;
    dynamic.appearanceKey = key;
    for (const accessory of dynamic.accessories) {
      accessory.removeFromParent(); const materials = new Set<THREE.Material>();
      accessory.traverse(node => { if (node instanceof THREE.Mesh) for (const material of Array.isArray(node.material) ? node.material : [node.material]) materials.add(material); });
      for (const material of materials) { this.faded.delete(material); dynamic.materials.delete(material); material.dispose(); }
    }
    dynamic.accessories = [];
    for (const [part, index, boneName] of [['head', appearance.head, 'head'], ['backpack', appearance.backpack, 'spine']] as const) {
      const original = dynamic.modelRoot.getObjectByName(`${part}-a`); if (original) original.visible = true;
      if (!index) continue;
      const generation = dynamic.generation;
      void this.asset(`character-${part}-b`).then(gltf => {
        if (this.disposed || this.dynamics.get(dynamic.entity.id) !== dynamic || dynamic.generation !== generation || dynamic.appearanceKey !== key) return;
        const bone = dynamic.modelRoot?.getObjectByName(boneName); if (!bone) return;
        const accessory = this.cloneForDynamic(gltf.scene, dynamic); bone.add(accessory); dynamic.accessories.push(accessory); if (original) original.visible = false;
      }).catch(() => { if (!this.disposed) this.onError('MODEL_UNAVAILABLE'); });
    }
  }
  private updateCrewMarker(dynamic: Dynamic) {
    if (dynamic.entity.kind !== 'character') return;
    const participant = this.view?.participants.find(p => p.entityId === dynamic.entity.id), seat = dynamic.entity.seatIndex ?? 0, bot = participant?.controller === 'bot';
    const key = `${seat}:${bot}`; let material = this.crewMaterials.get(key);
    if (!material) { const map = crewTexture(seat, bot); material = new THREE.SpriteMaterial({ map, depthTest: false, depthWrite: false }); this.resources.add(map); this.resources.add(material); this.crewMaterials.set(key, material); }
    if (!dynamic.marker) { dynamic.marker = new THREE.Sprite(material); dynamic.marker.position.set(0, 1.18, 0); dynamic.marker.scale.set(.34, .34, 1); dynamic.marker.renderOrder = 9; dynamic.root.add(dynamic.marker); }
    dynamic.marker.material = material;
  }
  setView(view: TyagaView) {
    const previous = this.view, reset = !previous || previous.rewinds !== view.rewinds || previous.tick > view.tick || this.mapId !== view.map.id + view.map.version;
    this.view = view;
    if (this.mapId !== view.map.id + view.map.version) this.buildMap(view);
    if (reset) { this.frames = []; this.firstFocus = true; this.lastEventId = null; this.clear(this.effects); this.particles = []; this.shakeUntil = 0; }
    this.frames.push({ time: performance.now(), view }); while (this.frames.length > 12) this.frames.shift();
    const present = new Set<string>();
    for (const entity of view.entities) {
      if (!entity.active || entity.kind === 'rope-segment') continue;
      present.add(entity.id); let dynamic = this.dynamics.get(entity.id);
      const model = entity.kind === 'deck' && entity.state === 'folded' ? 'deck-folded' : entity.model;
      if (!dynamic) {
        const root = new THREE.Group(); root.position.set(entity.position.x, entity.position.y, entity.position.z); root.quaternion.set(entity.rotation.x, entity.rotation.y, entity.rotation.z, entity.rotation.w); root.userData.entityId = entity.id;
        dynamic = { root, model, entity, generation: 0, materials: new Set(), skeletons: new Set(), wheels: [], accessories: [], damageUntil: 0 }; this.dynamics.set(entity.id, dynamic); this.actors.add(root); this.loadDynamic(dynamic);
      } else { dynamic.entity = entity; if (dynamic.model !== model) { dynamic.model = model; this.loadDynamic(dynamic); } }
      this.applyAppearance(dynamic); this.updateCrewMarker(dynamic);
    }
    for (const [id, dynamic] of this.dynamics) if (!present.has(id)) { this.actors.remove(dynamic.root); this.clearDynamic(dynamic); this.dynamics.delete(id); }
    this.updateConnections(view); this.updateSockets(view); this.updateEvents(view);
  }

  private removeCable(id: string, cable: CableVisual) { cable.mesh.removeFromParent(); cable.warning.removeFromParent(); cable.mesh.dispose(); cable.material.dispose(); this.cables.delete(id); }
  private updateConnections(view: Pick<TyagaView, 'connections'>) {
    const present = new Set<string>(), up = new THREE.Vector3(0, 1, 0), transform = new THREE.Object3D();
    for (const connection of view.connections) {
      if (connection.broken || connection.points.length < 2) continue;
      present.add(connection.id); const segments = connection.points.length - 1; let cable = this.cables.get(connection.id);
      if (cable && (cable.capacity < segments || cable.kind !== connection.kind)) { this.removeCable(connection.id, cable); cable = undefined; }
      if (!cable) {
        const material = new THREE.MeshStandardMaterial({ color: '#344955', roughness: connection.kind === 'strap' ? .95 : .5, metalness: connection.kind === 'strap' ? 0 : .45 });
        const mesh = new THREE.InstancedMesh(connection.kind === 'strap' ? this.strapGeometry : this.ropeGeometry, material, segments); mesh.frustumCulled = false; mesh.castShadow = true; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const warning = new THREE.Sprite(this.warningMaterial); warning.scale.set(.42, .42, 1); warning.renderOrder = 9; this.connections.add(mesh, warning);
        cable = { mesh, material, warning, capacity: segments, kind: connection.kind }; this.cables.set(connection.id, cable);
      }
      const ratio = connection.limit > 0 ? connection.tension / connection.limit : 0;
      cable.material.color.set(ratio > .9 ? '#D64A43' : ratio > .65 ? '#EBC75A' : connection.kind === 'strap' ? '#c7a34b' : '#344955'); cable.mesh.count = segments;
      for (let i = 0; i < segments; i++) {
        const a = new THREE.Vector3().copy(connection.points[i]), b = new THREE.Vector3().copy(connection.points[i + 1]), direction = b.clone().sub(a), length = direction.length();
        transform.position.copy(a).add(b).multiplyScalar(.5); transform.quaternion.setFromUnitVectors(up, length > .00001 ? direction.divideScalar(length) : up);
        transform.scale.set(connection.kind === 'strap' ? .065 : .028, Math.max(.001, length), connection.kind === 'strap' ? .018 : .028); transform.updateMatrix(); cable.mesh.setMatrixAt(i, transform.matrix);
      }
      cable.mesh.instanceMatrix.needsUpdate = true; cable.warning.visible = ratio > .65;
      const middle = connection.points[Math.floor(connection.points.length / 2)]; cable.warning.position.set(middle.x, middle.y + .35, middle.z);
    }
    for (const [id, cable] of this.cables) if (!present.has(id)) this.removeCable(id, cable);
  }
  private updateSockets(view: TyagaView) {
    const present = new Set<string>(), self = view.entities.find(entity => entity.participantId === view.participantId);
    for (const entity of view.entities) if (entity.active) for (const socket of entity.sockets) {
      if (!self || Math.hypot(socket.world.x - self.position.x, socket.world.y - self.position.y, socket.world.z - self.position.z) > 5) continue;
      const key = `${entity.id}:${socket.id}`; present.add(key); let marker = this.sockets.get(key);
      if (!marker) { marker = new THREE.Mesh(this.socketGeometry, this.socketFree); marker.renderOrder = 8; marker.userData.entityId = entity.id; marker.userData.socketId = socket.id; this.socketMarkers.add(marker); this.sockets.set(key, marker); }
      marker.material = socket.occupiedBy ? this.socketOccupied : this.socketFree; marker.scale.setScalar(socket.occupiedBy ? .75 : 1); marker.position.set(socket.world.x, socket.world.y, socket.world.z);
    }
    for (const [key, marker] of this.sockets) if (!present.has(key)) { marker.removeFromParent(); this.sockets.delete(key); }
    this.socketMarkers.visible = this.options.showSockets;
  }
  private updateEvents(view: TyagaView) {
    const last = Math.max(this.lastEventId ?? -1, ...view.events.map(event => event.id));
    if (this.lastEventId === null) { this.lastEventId = last; return; }
    const now = performance.now();
    for (const event of view.events) {
      if (event.id <= this.lastEventId) continue;
      if (!['damage', 'connection-broke', 'lift-catch', 'anchor-pulled'].includes(event.type)) continue;
      const dynamic = event.entityId ? this.dynamics.get(event.entityId) : undefined; if (!dynamic) continue;
      const distance = dynamic.root.position.distanceTo(this.focus);
      if (this.options.flashes && event.type === 'damage') dynamic.damageUntil = now + 240;
      if (!this.options.reducedMotion && distance < 16) {
        if (this.options.shake > 0) { this.shakeUntil = now + 220; this.shakeStrength = Math.min(.10, .025 + (event.amount ?? 3) * .003) * (1 - distance / 20); }
        for (let i = 0; i < (this.options.quality === 'low' ? 4 : 8) && this.particles.length < 64; i++) {
          const angle = i * 2.39996 + event.id, mesh = new THREE.Mesh(this.particleGeometry, this.particleMaterial); mesh.position.copy(dynamic.root.position); mesh.position.y -= dynamic.entity.size.y * .35; this.effects.add(mesh);
          const duration = .4 + i % 3 * .07; this.particles.push({ mesh, velocity: new THREE.Vector3(Math.cos(angle) * .8, .5 + i % 3 * .2, Math.sin(angle) * .8), life: duration, duration });
        }
      }
    }
    this.lastEventId = last;
  }

  private updateWheels(dynamic: Dynamic, before: WheelView[], after: WheelView[], t: number) {
    dynamic.root.updateMatrixWorld(true);
    for (const node of dynamic.wheels) {
      const wheel = after[node.index], old = before[node.index] ?? wheel; if (!wheel) continue;
      const world = new THREE.Vector3().copy(old.position).lerp(wheel.position, t);
      if (node.steering.parent) { node.steering.parent.updateWorldMatrix(true, false); node.steering.position.copy(node.steering.parent.worldToLocal(world)); }
      node.steering.rotation.y = THREE.MathUtils.lerp(old.steer, wheel.steer, t); node.spin.rotation.z = -THREE.MathUtils.lerp(old.rotation, wheel.rotation, t);
    }
  }
  private updateMechanisms(dynamic: Dynamic) {
    const view = this.view!;
    if (!dynamic.modelRoot) return;
    if (dynamic.entity.kind === 'truck') {
      const low = dynamic.modelRoot.getObjectByName('cargo-support-low'), high = dynamic.modelRoot.getObjectByName('cargo-support-high');
      if (low) low.visible = view.map.cargo[0] !== 'mast'; if (high) high.visible = view.map.cargo[0] === 'mast';
    }
    // The barrier retracts below the deck when its authoritative collider opens.
    // This keeps an open gate clear rather than leaving a visible solid obstacle.
    if (dynamic.entity.kind === 'barrier') dynamic.modelRoot.position.y = dynamic.entity.state === 'open' ? -.9 : 0;
    dynamic.modelRoot.traverse(node => { if (node.userData.damageOnly) node.visible = (dynamic.entity.integrity ?? 100) < 65; });
    const mechanism = dynamic.entity.mechanism;
    const rope = dynamic.entity.kind === 'winch' ? view.connections.find(c => c.kind === 'rope' && !c.broken && (c.fromId === dynamic.entity.id || c.toId === dynamic.entity.id)) : undefined;
    const drumAngle = mechanism?.drumAngle ?? (rope ? -rope.length / .16 : undefined);
    const drum = dynamic.modelRoot.getObjectByName('drum') ?? dynamic.modelRoot.getObjectByName('lift-drum'), handle = dynamic.modelRoot.getObjectByName('winch-handle');
    if (drum && drumAngle !== undefined) drum.rotation.z = drumAngle;
    if (handle && (mechanism?.crankAngle ?? drumAngle) !== undefined) handle.rotation.z = mechanism?.crankAngle ?? drumAngle!;
    const propeller = dynamic.modelRoot.getObjectByName('propeller'); if (propeller && mechanism?.propellerAngle !== undefined) propeller.rotation.x = mechanism.propellerAngle;
    const tiller = dynamic.modelRoot.getObjectByName('tiller'); if (tiller && mechanism?.steer !== undefined) tiller.rotation.y = mechanism.steer;
    const piston = dynamic.modelRoot.getObjectByName('jack-piston');
    if (piston && mechanism?.piston !== undefined) { piston.userData.restY ??= piston.position.y; piston.position.y = piston.userData.restY + mechanism.piston; }
  }
  private supportBelow(dynamic: Dynamic) {
    const origin = dynamic.root.position.clone(); origin.y += .02;
    this.raycaster.set(origin, new THREE.Vector3(0, -1, 0)); this.raycaster.far = 100;
    const hits = this.raycaster.intersectObjects([this.ground, this.actors], true);
    this.raycaster.far = Infinity;
    // A Surface proxy remains the physical support even when its authored
    // station/camp model hides that box. Decorative model overhangs are not floors.
    const hit = hits.find(h => h.object instanceof THREE.Mesh && !h.object.userData.decor && (h.object.userData.surfaceId || (visibleInScene(h.object) && h.object.userData.entityId && h.object.userData.entityId !== dynamic.entity.id && this.dynamics.get(h.object.userData.entityId)?.entity.kind !== 'character')));
    if (!hit || !(hit.object instanceof THREE.Mesh) || !hit.face) return null;
    const normal = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    if (normal.y < .25) return null;
    const x = new THREE.Vector3(1, 0, 0).applyQuaternion(dynamic.root.quaternion), y = new THREE.Vector3(0, 1, 0).applyQuaternion(dynamic.root.quaternion), z = new THREE.Vector3(0, 0, 1).applyQuaternion(dynamic.root.quaternion);
    const size = dynamic.entity.size, halfHeight = .5 * (Math.abs(x.y) * size.x + Math.abs(y.y) * size.y + Math.abs(z.y) * size.z);
    return { mesh: hit.object, point: hit.point, normal, bottom: dynamic.root.position.y - halfHeight };
  }
  private updateHeightIndicator(selected?: Dynamic, held?: Dynamic) {
    this.selectionRing.visible = false; this.heightLine.visible = false;
    for (const shadow of this.contactShadows) shadow.mesh.visible = false;
    const targets = [...new Set([selected, held].filter((target): target is Dynamic => !!target))];
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index], support = this.supportBelow(target); if (!support) continue;
      this.contactShadows[index].update(support.mesh, support.point, support.normal, target.root, target.entity.size, support.bottom - support.point.y, this.options.quality === 'low');
      if (target !== selected) continue;
      this.selectionRing.visible = true; this.selectionRing.position.copy(support.point).addScaledVector(support.normal, .045);
      this.selectionRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), support.normal);
      this.selectionRing.scale.set(Math.max(.7, Math.min(2.6, target.entity.size.x * .65)), Math.max(.7, Math.min(2.6, target.entity.size.z * .65)), 1);
      if (support.bottom - support.point.y > .18) {
        const positions = this.heightLine.geometry.getAttribute('position'); positions.setXYZ(0, target.root.position.x, support.point.y + .05, target.root.position.z); positions.setXYZ(1, target.root.position.x, support.bottom, target.root.position.z); positions.needsUpdate = true; this.heightLine.geometry.computeBoundingSphere(); this.heightLine.computeLineDistances(); this.heightLine.visible = true;
      }
    }
  }
  private updateOcclusion(self?: Dynamic) {
    const next = new Set<THREE.Material>();
    if (self) {
      const target = self.root.position.clone().add(new THREE.Vector3(0, .45, 0)), direction = target.clone().sub(this.camera.position), length = direction.length();
      this.raycaster.set(this.camera.position, direction.normalize()); this.raycaster.far = Math.max(0, length - .2);
      for (const hit of this.raycaster.intersectObjects([this.ground, this.actors], true)) {
        const object = hit.object;
        if (!(object instanceof THREE.Mesh) || object.userData.decor || object.userData.entityId === self.entity.id || !visibleInScene(object)) continue;
        if (!object.userData.surface && !object.userData.entityId) continue;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) next.add(material);
      }
      this.raycaster.far = Infinity;
    }
    for (const [material, original] of this.faded) if (!next.has(material)) { Object.assign(material, original); material.needsUpdate = true; this.faded.delete(material); }
    for (const material of next) if (!this.faded.has(material)) { this.faded.set(material, { opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite }); material.opacity = .26; material.transparent = true; material.depthWrite = false; material.needsUpdate = true; }
  }
  private tick = () => {
    if (this.disposed) return; this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min(this.clock.getDelta(), .05), now = performance.now();
    if (this.view) {
      const targetTime = now - 100, before = [...this.frames].reverse().find(f => f.time <= targetTime) ?? this.frames[0], after = this.frames.find(f => f.time >= targetTime) ?? this.frames.at(-1);
      if (before && after) {
        const t = before === after ? 1 : THREE.MathUtils.clamp((targetTime - before.time) / (after.time - before.time), 0, 1), previous = new Map(before.view.entities.map(e => [e.id, e]));
        for (const entity of after.view.entities) {
          const object = this.dynamics.get(entity.id); if (!object) continue; const old = previous.get(entity.id) ?? entity;
          object.root.position.set(THREE.MathUtils.lerp(old.position.x, entity.position.x, t), THREE.MathUtils.lerp(old.position.y, entity.position.y, t), THREE.MathUtils.lerp(old.position.z, entity.position.z, t)); object.root.quaternion.set(old.rotation.x, old.rotation.y, old.rotation.z, old.rotation.w).slerp(new THREE.Quaternion(entity.rotation.x, entity.rotation.y, entity.rotation.z, entity.rotation.w), t);
          const action = entity.animation ?? 'idle';
          if (object.mixer && object.current !== action) { const clip = object.clips?.get(action) ?? object.clips?.get('idle'); if (clip) { const current = object.current ? object.clips?.get(object.current) : undefined; if (current) object.mixer.clipAction(current).fadeOut(.12); object.mixer.clipAction(clip).reset().fadeIn(.12).play(); object.current = action; } }
          object.mixer?.update(dt); if (entity.kind === 'truck') this.updateWheels(object, before.view.truck.wheels, after.view.truck.wheels, t); this.updateMechanisms(object);
          for (const material of object.materials) if (material instanceof THREE.MeshStandardMaterial) {
            const intensity = this.options.flashes ? Math.max(0, (object.damageUntil - now) / 240) * .22 : 0, wear = 1 - (object.entity.integrity ?? 100) / 100;
            material.emissive.copy(material.userData.originalEmissive ?? new THREE.Color()); material.emissive.r += intensity; material.emissive.g += intensity * .14;
            material.color.copy(material.userData.originalColor ?? material.color).multiplyScalar(1 - wear * .18); material.roughness = Math.min(1, (material.userData.originalRoughness ?? material.roughness) + wear * .14);
          }
        }
        const oldConnections = new Map(before.view.connections.map(connection => [connection.id, connection]));
        this.updateConnections({ connections: after.view.connections.map(connection => {
          const old = oldConnections.get(connection.id); if (!old || old.points.length !== connection.points.length) return connection;
          return { ...connection, points: connection.points.map((point, i) => ({ x: THREE.MathUtils.lerp(old.points[i].x, point.x, t), y: THREE.MathUtils.lerp(old.points[i].y, point.y, t), z: THREE.MathUtils.lerp(old.points[i].z, point.z, t) })) };
        }) });
        for (const marker of this.sockets.values()) { const dynamic = this.dynamics.get(marker.userData.entityId), socket = dynamic?.entity.sockets.find(s => s.id === marker.userData.socketId); if (dynamic && socket) { dynamic.root.updateWorldMatrix(true, false); marker.position.copy(dynamic.root.localToWorld(new THREE.Vector3().copy(socket.local))); } }
      }
      const person = this.view.participants.find(p => p.participantId === this.view!.participantId), self = person ? this.dynamics.get(person.entityId) : undefined, truck = [...this.dynamics.values()].find(d => d.entity.kind === 'truck');
      const point = self?.root.position ?? truck?.root.position ?? new THREE.Vector3(this.view.map.start.x, 1, this.view.map.start.z), desired = point.clone();
      if (truck && (person?.controlling === truck.entity.id || this.view.truck.driver === this.view.participantId)) desired.copy(truck.root.position).add(new THREE.Vector3(truck.entity.velocity.x, 0, truck.entity.velocity.z).clampLength(0, 2));
      else if (truck && point.distanceTo(truck.root.position) <= 12) desired.multiplyScalar(.65).addScaledVector(truck.root.position, .35);
      desired.y += .5; if (this.firstFocus) { this.focus.copy(desired); this.firstFocus = false; } else this.focus.lerp(desired, 1 - Math.exp(-dt / .18));
      const elevation = 55 * Math.PI / 180, azimuth = Math.PI / 4, distance = 65, target = this.focus.clone();
      if (!this.options.reducedMotion && this.options.shake > 0 && now < this.shakeUntil) { const amplitude = this.shakeStrength * this.options.shake * (this.shakeUntil - now) / 220; target.x += Math.sin(now * .047) * amplitude; target.z += Math.sin(now * .061) * amplitude; }
      this.camera.position.set(target.x + Math.cos(elevation) * Math.cos(azimuth) * distance, target.y + Math.sin(elevation) * distance, target.z + Math.cos(elevation) * Math.sin(azimuth) * distance); this.camera.lookAt(target); this.camera.updateMatrixWorld();
      const sun = this.scene.getObjectByName('sun') as THREE.DirectionalLight; sun.position.copy(this.focus).add(new THREE.Vector3(-25, 48, 20)); sun.target.position.copy(this.focus); sun.target.updateMatrixWorld();
      this.scene.updateMatrixWorld(); this.updateHeightIndicator(this.selectedId ? this.dynamics.get(this.selectedId) : undefined, person?.holding ? this.dynamics.get(person.holding) : undefined); this.updateOcclusion(self);
      for (const child of this.ground.children) if (child.name === 'water') child.position.y = this.view.weather.waterLevel ?? child.userData.base;
      if (!this.options.reducedMotion) { this.waterNormal.offset.x += dt * .014; this.waterNormal.offset.y += dt * .008; }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) { const particle = this.particles[i]; particle.life -= dt; particle.velocity.y -= dt * 2.3; particle.mesh.position.addScaledVector(particle.velocity, dt); particle.mesh.scale.setScalar(Math.max(0, particle.life / particle.duration)); if (particle.life <= 0 || this.options.reducedMotion) { particle.mesh.removeFromParent(); this.particles.splice(i, 1); } }
    this.renderer.render(this.scene, this.camera);
  };

  private onWheel = (event: WheelEvent) => { event.preventDefault(); this.setZoom(this.zoom * Math.exp(-event.deltaY * .001)); };
  private onDown = (event: PointerEvent) => {
    this.pointerStarts.set(event.pointerId, { startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, pinched: false }); this.renderer.domElement.setPointerCapture(event.pointerId);
    if (this.pointerStarts.size === 2) { const [a, b] = [...this.pointerStarts.values()]; a.pinched = b.pinched = true; this.pinchStart = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: this.zoom }; }
  };
  private onMove = (event: PointerEvent) => {
    const pointer = this.pointerStarts.get(event.pointerId); if (!pointer) return; pointer.x = event.clientX; pointer.y = event.clientY;
    if (this.pinchStart) { const [a, b] = [...this.pointerStarts.values()]; if (a && b) this.setZoom(this.pinchStart.zoom * Math.hypot(a.x - b.x, a.y - b.y) / this.pinchStart.distance); }
  };
  private onUp = (event: PointerEvent) => {
    const start = this.pointerStarts.get(event.pointerId); this.pointerStarts.delete(event.pointerId); if (this.pointerStarts.size < 2) this.pinchStart = null;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) this.renderer.domElement.releasePointerCapture(event.pointerId);
    if (!start || start.pinched || Math.hypot(start.startX - event.clientX, start.startY - event.clientY) > 6) return;
    const rect = this.renderer.domElement.getBoundingClientRect(); this.raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), this.camera);
    const hit = this.raycaster.intersectObjects([this.actors, this.ground], true).find(h => !h.object.userData.decor && visibleInScene(h.object) && !(h.object instanceof THREE.Sprite));
    if (this.placement) { if (hit) this.onPlacementPoint({ x: hit.point.x, y: hit.point.y, z: hit.point.z }); return; }
    this.onSelect(hit?.object.userData.entityId ?? null, hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : undefined);
  };
  private onPointerLost = (event: PointerEvent) => { this.pointerStarts.delete(event.pointerId); if (this.pointerStarts.size < 2) this.pinchStart = null; };
  private onCancel = () => { for (const id of this.pointerStarts.keys()) if (this.renderer.domElement.hasPointerCapture(id)) this.renderer.domElement.releasePointerCapture(id); this.pointerStarts.clear(); this.pinchStart = null; };
  private onLost = (event: Event) => { event.preventDefault(); this.onCancel(); this.onContextLost(); };
  private onRestored = () => { this.renderer.setSize(this.width, this.height); };
  dispose() {
    if (this.disposed) return; this.disposed = true; this.setPlacementPreview(null); cancelAnimationFrame(this.frame); this.observer.disconnect(); this.onCancel(); this.restoreOccluders();
    const canvas = this.renderer.domElement; canvas.removeEventListener('wheel', this.onWheel); canvas.removeEventListener('pointerdown', this.onDown); canvas.removeEventListener('pointermove', this.onMove); canvas.removeEventListener('pointerup', this.onUp); canvas.removeEventListener('pointercancel', this.onCancel); canvas.removeEventListener('lostpointercapture', this.onPointerLost); canvas.removeEventListener('webglcontextlost', this.onLost); canvas.removeEventListener('webglcontextrestored', this.onRestored); window.removeEventListener('blur', this.onCancel);
    for (const dynamic of this.dynamics.values()) this.clearDynamic(dynamic); this.dynamics.clear(); for (const [id, cable] of this.cables) this.removeCable(id, cable);
    disposeResources(this.mapResources); disposeResources(this.resources); this.assets.clear(); this.renderer.dispose(); canvas.remove();
  }
}

/** Authored model preview for the launch screen; it does not represent gameplay acceptance. */
export function makeMenuScene(container: HTMLElement, reducedMotion: () => boolean = () => false): () => void {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-9, 9, 7, -7, .1, 150), resources = new Set<Resource>(); camera.position.set(14, 15, 17); camera.lookAt(0, 1, 0);
  scene.add(new THREE.HemisphereLight('#ffffff', '#6d8875', 3)); const sun = new THREE.DirectionalLight('#fff2d6', 4); sun.position.set(-10, 18, 8); scene.add(sun);
  const land = new THREE.Mesh(new RoundedBoxGeometry(13, 2.5, 10, 3, .6), new THREE.MeshStandardMaterial({ color: '#a9bc9d', roughness: .9 })); land.position.y = -1.25; scene.add(land);
  const road = new THREE.Mesh(new RoundedBoxGeometry(12, .2, 4.5, 2, .1), new THREE.MeshStandardMaterial({ color: '#cabda0', roughness: 1 })); scene.add(road); collectResources(scene, resources);
  let stopped = false, frame = 0; const loader = new GLTFLoader(), mixers: THREE.AnimationMixer[] = [], clock = new THREE.Clock();
  for (const [model, x, y, z] of [['truck', 0, .95, 0], ['crate', -.3, .9, 0], ['generator-large', -.65, 2.57, 0], ['character', 3.2, .875, 2.5], ['rock-a', -4.4, 0, -3.4], ['tree-pine', -4.5, 0, -3.5], ['grass', 4.8, 0, -3.7]] as const) void loader.loadAsync(base + model + '.glb').then(gltf => {
    const loaded = new Set<Resource>(); collectResources(gltf.scene, loaded); if (stopped) { disposeResources(loaded); return; } for (const resource of loaded) resources.add(resource);
    const highSupports = gltf.scene.getObjectByName('cargo-support-high'); if (highSupports) highSupports.visible = false;
    gltf.scene.position.set(x, y, z); scene.add(gltf.scene); const idle = gltf.animations.find(clip => clip.name.toLowerCase() === 'idle'); if (idle) { const mixer = new THREE.AnimationMixer(gltf.scene); mixer.clipAction(idle).play(); mixers.push(mixer); }
  }).catch(() => {});
  const resize = () => { const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight); renderer.setSize(width, height); const aspect = width / height; camera.left = -7 * aspect; camera.right = 7 * aspect; camera.updateProjectionMatrix(); };
  container.appendChild(renderer.domElement); const observer = new ResizeObserver(resize); observer.observe(container); resize();
  const loop = () => { if (!stopped) { frame = requestAnimationFrame(loop); const dt = Math.min(clock.getDelta(), .05); if (!reducedMotion() && !matchMedia('(prefers-reduced-motion: reduce)').matches) for (const mixer of mixers) mixer.update(dt); renderer.render(scene, camera); } }; loop();
  return () => { if (stopped) return; stopped = true; cancelAnimationFrame(frame); observer.disconnect(); for (const mixer of mixers) { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); } scene.traverse(node => { if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose(); }); disposeResources(resources); renderer.dispose(); renderer.domElement.remove(); };
}
