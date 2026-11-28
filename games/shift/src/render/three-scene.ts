import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getArena, ROOM_IDS } from '../core/arenas';
import { cellOrigin, getDoors, goalPosition, roomOrigin, worldPosition } from '../core/geometry';
import type { ArenaId, Direction, VisibleActor } from '../core/types';
import type { Project, ScreenPoint, ShiftRendererProps } from './types';
import { ARENA_COLORS } from './types';

const ASSET_IDS = ['module-slab', 'wall-profile', 'door', 'shaft', 'airlock', 'cover', 'pillar', 'drone-teal', 'drone-amber', 'battery', 'pedestal', 'gate'] as const;
type AssetId = typeof ASSET_IDS[number];
type Instance = { x: number; y: number; z: number; rotation?: number; scaleX?: number; scaleY?: number; scaleZ?: number };
interface TemplatePart { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial }
interface Batch { mesh: THREE.InstancedMesh; source: TemplatePart; }
const turns: Record<Direction, number> = { north: 0, east: -Math.PI / 2, south: Math.PI, west: Math.PI / 2 };

let templatePromise: Promise<Map<AssetId, TemplatePart[]>> | null = null;
function templates(): Promise<Map<AssetId, TemplatePart[]>> {
  if (!templatePromise) {
    const loader = new GLTFLoader();
    templatePromise = Promise.all(ASSET_IDS.map(async id => {
      const loaded = await loader.loadAsync('/shift-assets/models/' + id + '.glb');
      const parts: TemplatePart[] = [];
      loaded.scene.updateMatrixWorld(true);
      loaded.scene.traverse(node => {
        if (!(node instanceof THREE.Mesh)) return;
        const material = Array.isArray(node.material) ? node.material[0] : node.material;
        if (!(material instanceof THREE.MeshStandardMaterial)) return;
        const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
        parts.push({ geometry, material });
      });
      if (!parts.length) throw new Error('Empty model: ' + id);
      return [id, parts] as const;
    })).then(entries => new Map(entries)).catch(error => { templatePromise = null; throw error; });
  }
  return templatePromise;
}

/** Instanced original GLB meshes. Rendering has no collision or visibility authority. */
export class ShiftThreeScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-16, 16, 14, -14, .1, 120);
  private batches = new Map<AssetId, Batch[]>();
  private readonly transform = new THREE.Object3D();
  private readonly vector = new THREE.Vector3();
  private readonly raycaster = new THREE.Raycaster();
  private readonly floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private readonly light: THREE.DirectionalLight;
  private disposed = false;
  private ready = false;
  private width = 1;
  private height = 1;
  private arena: ArenaId | null = null;
  private high = false;
  private renderKey = '';
  private readonly backgroundObjects: THREE.Object3D[] = [];

  constructor(private canvas: HTMLCanvasElement, onReady: () => void, onFailure: () => void) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.24;
    this.renderer.setClearColor('#0b151d', 1);
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.camera.up.set(0, 0, -1);
    this.light = new THREE.DirectionalLight('#fff0cf', 3.4);
    this.light.position.set(-6, 23, -5);
    this.light.target.position.set(8, 0, 8);
    this.light.shadow.camera.left = -23; this.light.shadow.camera.right = 23;
    this.light.shadow.camera.top = 23; this.light.shadow.camera.bottom = -23;
    this.light.shadow.camera.near = 1; this.light.shadow.camera.far = 60;
    this.light.shadow.mapSize.set(1024, 1024);
    this.light.shadow.bias = -.001; this.light.shadow.normalBias = .05;
    this.scene.add(this.light, this.light.target, new THREE.HemisphereLight('#bacfd6', '#22313b', 2.3));
    const rim = new THREE.DirectionalLight('#b7e7f1', 1.7); rim.position.set(25, 12, 19); this.scene.add(rim);
    const base = new THREE.Mesh(new THREE.BoxGeometry(34, .35, 26), new THREE.MeshStandardMaterial({ color: '#17252e', roughness: .8, metalness: .35 }));
    base.position.set(8, -1.85, 8); base.receiveShadow = true; this.scene.add(base); this.backgroundObjects.push(base);
    const grid = new THREE.GridHelper(70, 70, '#3a5961', '#1b313d'); grid.position.set(8, -2.04, 8); this.scene.add(grid); this.backgroundObjects.push(grid);
    void templates().then(all => {
      if (this.disposed) return;
      for (const [id, parts] of all) {
        const set: Batch[] = [];
        for (const source of parts) {
          const mesh = new THREE.InstancedMesh(source.geometry, source.material.clone(), 64);
          mesh.name = 'shift-' + id + '-' + source.material.name;
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          mesh.count = 0; mesh.frustumCulled = false;
          mesh.castShadow = !['module-slab', 'shaft', 'airlock', 'gate'].includes(id); mesh.receiveShadow = true;
          this.scene.add(mesh); set.push({ mesh, source });
        }
        this.batches.set(id, set);
      }
      this.ready = true; onReady();
    }).catch(() => { if (!this.disposed) onFailure(); });
  }

  resize(width: number, height: number, high: boolean) {
    if (this.width === width && this.height === height && this.high === high) return;
    this.width = width; this.height = height; this.high = high;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 2 : 1.35));
    this.renderer.setSize(width, height, false);
    this.renderer.shadowMap.enabled = high; this.light.castShadow = high;
  }

  private submit(id: AssetId, instances: Instance[]) {
    const batches = this.batches.get(id);
    if (!batches) return;
    for (const batch of batches) {
      batch.mesh.count = Math.min(64, instances.length);
      for (let i = 0; i < batch.mesh.count; i++) {
        const instance = instances[i];
        this.transform.position.set(instance.x, instance.y, instance.z);
        this.transform.rotation.set(0, instance.rotation ?? 0, 0);
        this.transform.scale.set(instance.scaleX ?? 1, instance.scaleY ?? 1, instance.scaleZ ?? 1);
        this.transform.updateMatrix(); batch.mesh.setMatrixAt(i, this.transform.matrix);
      }
      batch.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private style(arena: ArenaId) {
    if (arena === this.arena) return;
    this.arena = arena;
    const theme = ARENA_COLORS[arena];
    for (const [id, parts] of this.batches) for (const part of parts) {
      const material = part.mesh.material as THREE.MeshStandardMaterial;
      const name = part.source.material.name;
      material.metalness = part.source.material.metalness;
      if (name === 'floor') material.color.set(theme.floor);
      if (name === 'cover') material.color.set(theme.cover);
      if (name === 'mark' && id === 'module-slab') material.color.set(theme.accent);
      if (arena === 'calibration' && (id === 'cover' || id === 'pillar') && name === 'cover') material.metalness = .22;
    }
  }

  render(props: ShiftRendererProps, tick: number, actors: VisibleActor[]) {
    const view = props.view, arena = getArena(view.settings.arena), pilot = view.self.role === 'pilot';
    const self = actors.find(a => a.seatId === view.self.seatId);
    let center = { x: 8, z: 8 };
    if (pilot && self && !props.reducedMotion) center = worldPosition(view.board, self, view.motion, tick);
    // Reduced motion keeps the complete floor in a fixed camera instead of
    // snapping the pilot camera between local spaces.
    const aspect = this.width / this.height;
    const halfHeight = pilot && !props.reducedMotion ? Math.max(8.1, 9.7 / aspect) : Math.max(13.5, 17 / aspect);
    const key = JSON.stringify([this.width, this.height, this.high, this.ready, view.settings.arena, pilot, props.reducedMotion,
      view.board, view.motion ? [view.motion.roomId, tick] : null, center,
      actors.map(a => [a.seatId, a.spaceId, a.x, a.z, a.aim, a.hp, a.carrying]), view.battery]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    this.camera.left = -halfHeight * aspect; this.camera.right = halfHeight * aspect;
    this.camera.top = halfHeight; this.camera.bottom = -halfHeight;
    this.camera.up.set(0, pilot ? 1 : 0, pilot ? 0 : -1);
    this.camera.position.set(center.x, 30, center.z + (pilot ? Math.tan(28 * Math.PI / 180) * 30 : 0));
    this.camera.lookAt(center.x, 0, center.z); this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld(true);
    if (this.ready) {
      this.style(view.settings.arena);
      const tiles: Instance[] = [], walls: Instance[] = [], covers: Instance[] = [], pillars: Instance[] = [], doors: Instance[] = [];
      for (const room of ROOM_IDS) {
        const o = roomOrigin(view.board, room, view.motion, tick);
        tiles.push({ x: o.x, y: 0, z: o.z });
        for (const direction of ['north', 'east', 'south', 'west'] as const) {
          walls.push({ x: o.x, y: 0, z: o.z, rotation: turns[direction], scaleY: pilot && direction === 'south' ? .5 : 1 });
        }
        for (const c of arena.covers[room]) (c.kind === 'pillar' ? pillars : covers).push({ x: o.x + c.x, y: .012, z: o.z + c.z, scaleX: c.width, scaleZ: c.depth, scaleY: c.height / (c.kind === 'pillar' ? 1.4325 : .94) });
      }
      for (const door of getDoors(view.board, view.motion, tick)) {
        if (door.spaceId === 'west' || door.spaceId === 'east') continue;
        // The confirmed public door state controls both the shutter and the overlay.
        if (!door.open) doors.push({ x: door.x, y: 0, z: door.z, rotation: turns[door.direction] });
      }
      this.submit('module-slab', tiles); this.submit('wall-profile', walls); this.submit('cover', covers); this.submit('pillar', pillars); this.submit('door', doors);
      const empty = cellOrigin(view.board.indexOf(null));
      this.submit('shaft', [{ x: empty.x, y: 0, z: empty.z }]);
      this.submit('airlock', [{ x: -6, y: 0, z: 8 }, { x: 22, y: 0, z: 8, rotation: Math.PI }]);
      this.submit('gate', (['west', 'east'] as const).map(side => { const p = worldPosition(view.board, goalPosition(side)); return { x: p.x, y: .01, z: p.z }; }));
      const pedestal = roomOrigin(view.board, 'O', view.motion, tick); this.submit('pedestal', [{ x: pedestal.x, y: .01, z: pedestal.z }]);
      for (const team of ['teal', 'amber'] as const) {
        this.submit(team === 'teal' ? 'drone-teal' : 'drone-amber', actors.filter(a => a.team === team).map(a => {
          const w = worldPosition(view.board, a, view.motion, tick);
          return { x: w.x, y: a.hp > 0 ? .06 : -.07, z: w.z, rotation: -a.aim, scaleY: a.hp > 0 ? 1 : .23 };
        }));
      }
      const batteryInstances: Instance[] = [];
      if (view.battery.mode === 'carried') {
        const carrier = actors.find(a => a.carrying);
        if (carrier) { const p = worldPosition(view.board, carrier, view.motion, tick); batteryInstances.push({ x: p.x - Math.cos(carrier.aim) * .18, y: .48, z: p.z - Math.sin(carrier.aim) * .18, scaleX: .75, scaleY: .75, scaleZ: .75 }); }
      } else if (view.battery.spaceId && view.battery.x !== undefined && view.battery.z !== undefined) {
        const p = worldPosition(view.board, { spaceId: view.battery.spaceId, x: view.battery.x, z: view.battery.z }, view.motion, tick);
        batteryInstances.push({ x: p.x, y: view.battery.mode === 'pedestal' ? .18 : .02, z: p.z });
      }
      this.submit('battery', batteryInstances);
    }
    this.renderer.render(this.scene, this.camera);
    this.canvas.dataset.drawCalls = String(this.renderer.info.render.calls);
    this.canvas.dataset.triangles = String(this.renderer.info.render.triangles);
    this.canvas.dataset.assetsReady = String(this.ready);
  }

  readonly project: Project = (x, z, height = 0): ScreenPoint => {
    this.vector.set(x, height, z).project(this.camera);
    return { x: (this.vector.x + 1) * this.width / 2, y: (1 - this.vector.y) * this.height / 2 };
  };

  unproject(x: number, y: number) {
    this.raycaster.setFromCamera(new THREE.Vector2(x / this.width * 2 - 1, 1 - y / this.height * 2), this.camera);
    const point = this.raycaster.ray.intersectPlane(this.floor, this.vector);
    return point ? { x: point.x, z: point.z } : null;
  }

  dispose() {
    this.disposed = true;
    for (const parts of this.batches.values()) for (const part of parts) {
      (part.mesh.material as THREE.Material).dispose();
      // Shared template geometries survive a 2D/3D switch and are not disposed here.
      this.scene.remove(part.mesh); part.mesh.dispose();
    }
    for (const object of this.backgroundObjects) {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        if (Array.isArray(object.material)) object.material.forEach(m => m.dispose()); else object.material.dispose();
      }
    }
    this.renderer.dispose();
  }
}
