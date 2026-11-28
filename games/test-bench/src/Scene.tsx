import { useEffect, useRef, useState } from 'react';
import { createRoot, useFrame } from '@react-three/fiber';
import type { RootStore } from '@react-three/fiber';
import * as T from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PARTS, SLOT_NAMES } from './catalog';
import { groundHeight, terrainMesh } from './tracks';
import type { Blueprint, CargoKind, LaneSnapshot, Locale, SlotId, TrackDefinition } from './types';

export interface TestBenchSceneProps {
  blueprint: Blueprint;
  lane?: LaneSnapshot | null;
  track: TrackDefinition;
  mode: 'workshop' | 'race';
  renderer?: '3d' | '2d';
  quality?: 'low' | 'high';
  reducedMotion?: boolean;
  /** Cosmetic impact dust and wet tyre spray. Physical motion remains visible. */
  effects?: boolean;
  locale: Locale;
  /** Portal seat gives all six participants a distinct, stable chassis paint. */
  seatIndex?: number;
  /** Stable fallback identity for standalone previews without a room seat. */
  participantId?: string;
  /** Workshop/spectator azimuth in radians. */
  rotation?: number;
  topView?: boolean;
  selectedSlot?: SlotId;
  onSlotSelect?: (slot: SlotId) => void;
  /** Optional public scene metrics; measures rendering, not physical-device acceptance. */
  onMetrics?: (metrics: { drawCalls: number; triangles: number; frameP95Ms: number; renderer: '3d' | '2d' }) => void;
}

const ASSET_ROOT = '/test-bench/';
export function lowQualityPixelRatio(cssWidth: number, cssHeight: number, devicePixelRatio: number): number {
  return Math.min(devicePixelRatio || 1, 1.25, Math.sqrt(230400 / (Math.max(1, cssWidth) * Math.max(1, cssHeight))));
}
export const PARTICIPANT_PALETTE = ['#efae48', '#35a58c', '#db6e60', '#6d93c4', '#a38ac2', '#9eaa52'] as const;
export function participantPaint(seatIndex?: number, participantId?: string): string {
  let index = 0;
  if (Number.isInteger(seatIndex) && Number(seatIndex) >= 0) index = Number(seatIndex);
  else if (participantId) for (const character of participantId) index = (Math.imul(index, 31) + character.charCodeAt(0)) >>> 0;
  return PARTICIPANT_PALETTE[index % PARTICIPANT_PALETTE.length];
}
const assetCache = new Map<string, Promise<T.Group>>();
const loader = new GLTFLoader();
async function asset(id: string): Promise<T.Group> {
  let promise = assetCache.get(id);
  if (!promise) {
    promise = loader.loadAsync(`${ASSET_ROOT}models/${id}.glb`).then(result => result.scene).catch(error => { assetCache.delete(id); throw error; });
    assetCache.set(id, promise);
  }
  const model = (await promise).clone(true);
  model.traverse(node => { if (node instanceof T.Mesh) { node.castShadow = true; node.receiveShadow = true; } });
  return model;
}

const slots: Record<SlotId, [number, number, number]> = {
  'front-axle': [0, -.03, .8], 'rear-axle': [0, -.03, -.8],
  motor: [0, .13, .59], battery: [0, .13, -.67], cargo: [0, .10, -.12],
  'aux-left': [-.55, -.055, 0], 'aux-right': [.55, -.055, 0],
};
const cargoModels: Record<CargoKind, string> = { egg: 'egg', instrument: 'block', 'power-cell': 'cell' };
function modelId(slot: SlotId, part: string): string {
  if (slot.endsWith('axle')) return `axle-${part === 'terrain' ? 'offroad' : part}`;
  if (slot.startsWith('aux')) return `aux-${part.startsWith('damper') ? 'damper' : part}`;
  return `${slot}-${part}`;
}

interface Vehicle {
  group: T.Group;
  modules: Map<SlotId, T.Group>;
  wheels: { steer: T.Object3D; spin: T.Object3D; suspension?: T.Object3D; index: number }[];
  ownedMaterials: T.Material[];
}
async function vehicle(blueprint: Blueprint, paint: string): Promise<Vehicle> {
  const group = new T.Group(); group.name = 'test-bench-vehicle';
  const chassis = await asset('chassis'); group.add(chassis);
  const ownedMaterials: T.Material[] = [];
  chassis.traverse(node => {
    if (node instanceof T.Mesh && node.material instanceof T.MeshStandardMaterial && node.material.name === 'test-bench-chassis-paint') {
      const material = node.material.clone(); material.color.set(paint); node.material = material; ownedMaterials.push(material);
    }
  });
  const modules = new Map<SlotId, T.Group>(); const wheels: Vehicle['wheels'] = [];
  await Promise.all((Object.keys(slots) as SlotId[]).map(async slot => {
    const part = blueprint[slot]; if (!part) return;
    const model = await asset(modelId(slot, part)); model.name = slot;
    model.position.set(...slots[slot]); model.userData.slot = slot;
    if (part === 'rollbar') model.position.set(0, 0, 0);
    if (part.startsWith('damper')) model.position.set(slot === 'aux-left' ? -.57 : .57, -.04, part.endsWith('front') ? .8 : -.8);
    group.add(model); modules.set(slot, model);
    if (slot.endsWith('axle')) {
      const front = slot === 'front-axle';
      for (const [side, offset] of [['left', 0], ['right', 1]] as const) {
        const steer = model.getObjectByName(`wheel-${side}-steer`);
        const spin = steer?.getObjectByName('wheel-spin');
        if (steer && spin) wheels.push({ steer, spin, suspension: model.getObjectByName(`suspension-${side}`), index: (front ? 0 : 2) + offset });
      }
    }
  }));
  return { group, modules, wheels, ownedMaterials };
}

function textPlate(text: string, color = '#263944', background = '#f4f1e9', width = 1.6, height = .40): T.Mesh {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
  const context = canvas.getContext('2d')!;
  context.fillStyle = background; context.fillRect(0, 0, 512, 128);
  context.strokeStyle = color; context.lineWidth = 3; context.strokeRect(10, 10, 492, 108);
  context.font = '600 48px "Golos Text", sans-serif'; context.fillStyle = color; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(text, 256, 67, 470);
  const texture = new T.CanvasTexture(canvas); texture.colorSpace = T.SRGBColorSpace;
  const material = new T.MeshBasicMaterial({ map: texture, transparent: false, side: T.DoubleSide });
  const mesh = new T.Mesh(new T.PlaneGeometry(width, height), material); mesh.userData.textPlate = true; return mesh;
}

function paintedLine(start: T.Vector3, end: T.Vector3, width: number, color: number): T.Mesh {
  const delta = end.clone().sub(start);
  const mesh = new T.Mesh(new T.PlaneGeometry(width, delta.length()), new T.MeshStandardMaterial({ color, roughness: .9, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }));
  mesh.rotation.x = -Math.PI / 2; mesh.rotation.z = -Math.atan2(delta.x, delta.z); mesh.position.copy(start).add(end).multiplyScalar(.5); mesh.position.y += .008;
  return mesh;
}

/** Batches cloned, static final GLBs by material class. No gameplay data is inferred from art. */
function batchEnvironment(source: T.Group): T.Group {
  source.updateMatrixWorld(true);
  const batches = new Map<string, { material: T.Material; geometries: T.BufferGeometry[] }>();
  source.traverse(node => {
    if (!(node instanceof T.Mesh) || Array.isArray(node.material)) return;
    const material = node.material as T.MeshStandardMaterial;
    const key = material.name.startsWith('workshop-palette') ? material.name : material.uuid;
    const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
    if (!batches.has(key)) batches.set(key, { material, geometries: [] });
    batches.get(key)!.geometries.push(geometry.index ? geometry.toNonIndexed() : geometry);
  });
  const result = new T.Group();
  for (const { material, geometries } of batches.values()) {
    const geometry = mergeGeometries(geometries, false);
    if (geometry) { const mesh = new T.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true; result.add(mesh); }
    geometries.forEach(geo => geo.dispose());
  }
  return result;
}

async function buildWorld(scene: T.Group, props: TestBenchSceneProps): Promise<{ gates: T.Mesh[]; slotTargets: T.Mesh[] }> {
  const { mode, track, locale } = props;
  const staticModels = new T.Group();
  const put = async (id: string, x: number, y: number, z: number, angle = 0, scale?: [number, number, number]) => {
    const model = await asset(id); model.position.set(x, y, z); model.rotation.y = angle; if (scale) model.scale.set(...scale); staticModels.add(model); return model;
  };
  const jobs: Promise<unknown>[] = [];
  const ivory = new T.MeshStandardMaterial({ color: '#d9d5c8', roughness: .94 });
  const floor = new T.Mesh(new T.PlaneGeometry(mode === 'workshop' ? 100 : 80, 100), new T.MeshStandardMaterial({ color: '#c5c9bf', roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, mode === 'workshop' ? -1.02 : -.66, 25); floor.receiveShadow = true; scene.add(floor);
  const gates: T.Mesh[] = []; const slotTargets: T.Mesh[] = [];
  if (mode === 'workshop') {
    const bench = new T.Mesh(new T.BoxGeometry(6.4, .20, 5.1), new T.MeshStandardMaterial({ color: '#e6dcc4', roughness: .86 })); bench.position.y = -.55; bench.receiveShadow = true; scene.add(bench);
    const mat = new T.Mesh(new T.BoxGeometry(3.7, .025, 3.6), new T.MeshStandardMaterial({ color: '#a7b4a5', roughness: 1 })); mat.position.y = -.435; mat.receiveShadow = true; scene.add(mat);
    const grid = new T.GridHelper(3.6, 18, '#d8dfcf', '#c2cebb'); grid.position.y = -.419; scene.add(grid);
    jobs.push(put('toolbox', 2.1, -.44, -1.5, -.25, [.7, .7, .7]), put('stool', -3.8, -1, .3), put('drawer-cabinet', -3.7, -1, -2.3), put('pegboard', 0, -1, -3.1), put('lamp', 3.9, -1, -1.5), put('crate', -2.5, -.44, -.5, .15, [.7, .7, .7]), put('cable-spool', 2.4, -.44, .3, 0, [.7, .7, .7]), put('plant', -3.8, .07, -2.3), put('fire-extinguisher', 3.8, -1, 1.4));
    const plaque = textPlate('IVA  /  01', '#263944', '#f4f1e9', .9, .22); plaque.rotation.x = -Math.PI / 2; plaque.position.set(2.25, -.437, 1.48); scene.add(plaque);
    for (const slot of Object.keys(slots) as SlotId[]) {
      const [x, , z] = slots[slot];
      const ring = new T.Mesh(new T.TorusGeometry(slot.endsWith('axle') ? .28 : .17, .018, 6, 32), new T.MeshBasicMaterial({ color: '#ffbd49', transparent: true, opacity: .85, depthTest: false }));
      ring.rotation.x = -Math.PI / 2; ring.position.set(x, .52, z); ring.userData.slot = slot; ring.renderOrder = 5; slotTargets.push(ring); scene.add(ring);
    }
  } else {
    const { vertices, indices } = terrainMesh(track);
    const geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.BufferAttribute(vertices, 3)); geometry.setIndex(new T.BufferAttribute(indices, 1)); geometry.computeVertexNormals();
    const terrain = new T.Mesh(geometry, ivory); terrain.receiveShadow = true; scene.add(terrain);
    const base = new T.Mesh(new T.BoxGeometry(7.65, .58, 60), new T.MeshStandardMaterial({ color: '#8b9890', roughness: .85 })); base.position.set(0, -.34, 24); base.receiveShadow = true; scene.add(base);
    for (let z = -4; z <= 51; z += 2) {
      for (const side of [-1, 1]) {
        const y = groundHeight(track, side * 3.6, z);
        jobs.push(put('edge', side * 3.75, y, z, 0, [1, 1, 2]));
      }
    }
    for (let z = -3; z <= 50; z += 3) {
      const y = groundHeight(track, 0, z);
      for (const side of [-1, 1]) scene.add(paintedLine(new T.Vector3(side * 3.18, y, z), new T.Vector3(side * 3.18, groundHeight(track, side * 3.18, z + 1), z + 1), .07, 0xf4f1e9));
    }
    for (const [i, gate] of track.orderedGates.entries()) {
      jobs.push(put('gate', gate.x, groundHeight(track, gate.x, gate.z), gate.z, 0, [gate.width / 2.1, 1, 1]));
      const label = textPlate(String(i + 1).padStart(2, '0'), '#263944', '#ffbd49', .50, .30); label.position.set(gate.x, groundHeight(track, gate.x, gate.z) + 1.7, gate.z); label.rotation.y = Math.PI; scene.add(label);
      const line = new T.Mesh(new T.PlaneGeometry(gate.width, .12), new T.MeshBasicMaterial({ color: '#ffbd49', side: T.DoubleSide })); line.rotation.x = -Math.PI / 2; line.position.set(gate.x, groundHeight(track, gate.x, gate.z) + .02, gate.z); gates.push(line); scene.add(line);
      if (track.id === 'precision') for (const side of [-1, 1]) {
        const edge = gate.x + side * gate.width / 2;
        const wallEdge = side * track.width / 2;
        jobs.push(put('barrier', (edge + wallEdge) / 2, 0, gate.z, 0, [Math.abs(wallEdge - edge), .56 / .33, 1]));
      }
    }
    // Dock artwork stays beside the driving line. The loading area itself is painted below.
    jobs.push(put('loading-dock', -2.3, .0, track.loadingDock.z, Math.PI / 2), put('start-light', 2.5, .0, -.8, Math.PI));
    const loading = new T.Mesh(new T.RingGeometry(.9, 1.04, 40), new T.MeshBasicMaterial({ color: '#ffbd49', side: T.DoubleSide })); loading.rotation.x = -Math.PI / 2; loading.position.set(track.loadingDock.x, .012, track.loadingDock.z); scene.add(loading);
    const dockLabel = textPlate(locale === 'ru' ? 'ЗАГРУЗКА' : 'LOAD', '#263944', '#ffbd49', 1.55, .33); dockLabel.rotation.x = -Math.PI / 2; dockLabel.rotation.z = Math.PI; dockLabel.position.set(0, .015, 1.6); scene.add(dockLabel);
    const finishZ = (track.unload.minZ + track.unload.maxZ) / 2;
    jobs.push(put('unload-pad', 0, groundHeight(track, 0, finishZ) + .005, finishZ, 0, [(track.unload.maxX - track.unload.minX) / 3.6, 1, (track.unload.maxZ - track.unload.minZ) / 3]));
    const finishLabel = textPlate(locale === 'ru' ? 'СДАЧА ГРУЗА' : 'UNLOAD', '#f4f1e9', '#238e7c', 2.4, .4); finishLabel.rotation.x = -Math.PI / 2; finishLabel.rotation.z = Math.PI; finishLabel.position.set(0, groundHeight(track, 0, finishZ) + .046, finishZ); scene.add(finishLabel);
    if (track.ramp) {
      const ramp = track.ramp;
      // A beveled course is already drawn by the exact shared terrain mesh.
      // A straight exported wedge would float above its rounded entry/exit.
      if (!ramp.bevel) {
        jobs.push(put('ramp', 0, .003, (ramp.start + ramp.end) / 2, 0, [track.width, ramp.height, ramp.end - ramp.start]));
        if (ramp.downStart !== undefined && ramp.downEnd !== undefined) jobs.push(put('ramp', 0, .003, (ramp.downStart + ramp.downEnd) / 2, Math.PI, [track.width, ramp.height, ramp.downEnd - ramp.downStart]));
      }
    }
    for (const rib of track.ribs) {
      const center = -rib.smoothSide * .7;
      jobs.push(put('rib', center, .003, rib.z, 0, [5.8, rib.height / .1, 1]));
      jobs.push(put('rib', rib.smoothSide * 3.075, .003, rib.z, 0, [1.05, .18, 1]));
    }
    if (track.wet) {
      const w = track.width - track.wet.dryWidth;
      const z = (track.wet.minZ + track.wet.maxZ) / 2;
      const puddle = new T.Mesh(new T.PlaneGeometry(w, track.wet.maxZ - track.wet.minZ), new T.MeshStandardMaterial({ color: '#638a91', roughness: props.quality === 'low' ? .8 : .25, metalness: .12 })); puddle.rotation.x = -Math.PI / 2; puddle.position.set(-track.wet.drySide * track.wet.dryWidth / 2, .012, z); scene.add(puddle);
      for (let i = 0; i < 5; i++) { const wave = new T.Mesh(new T.RingGeometry(.28 + i * .05, .29 + i * .05, 30), new T.MeshBasicMaterial({ color: '#b4d2cf', transparent: true, opacity: .42 })); wave.rotation.x = -Math.PI / 2; wave.scale.x = 1.8; wave.position.set(i % 2 ? -1.6 : 1.2, .017, track.wet.minZ + 1 + i * 1.4); scene.add(wave); }
      jobs.push(put('puddle', -track.wet.drySide * 1.4, .01, track.wet.minZ + 2, 0, [1.8, 1, 1.8]));
    }
    const propsList = ['workbench', 'drawer-cabinet', 'lamp', 'toolbox', 'stool', 'crate', 'pegboard', 'cable-spool', 'fire-extinguisher', 'plant'];
    for (let i = 0; i < 16; i++) jobs.push(put(propsList[i % propsList.length], (i % 2 ? 1 : -1) * (5.2 + (i % 3) * .25), -.62, -1 + i * 3.2, i % 2 ? -Math.PI / 2 : Math.PI / 2));
  }
  await Promise.all(jobs);
  scene.add(batchEnvironment(staticModels));
  if (mode === 'race') scene.traverse(node => { if (node.userData.textPlate) node.scale.x = -1; });
  // Line meshes are static too. Consolidate their equal materials outside dynamic gate indicators.
  return { gates, slotTargets };
}

/** R3F owns frame scheduling and rendering; the game owns its original scene graph. */
function BenchFrame({ update }: { update: (time: number) => void }) {
  useFrame(() => update(performance.now()));
  return null;
}

function ThreeScene({ onFailure, ...props }: TestBenchSceneProps & { onFailure: () => void }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props); const callback = useRef(onFailure);
  useEffect(() => { latest.current = props; callback.current = onFailure; });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const surface = surfaceRef.current; if (!surface) return;
    // A fresh DOM canvas per root prevents a retired R3F root from sharing a
    // WebGL context with its successor during a quality/locale or StrictMode cycle.
    const canvas = document.createElement('canvas'); canvas.className = 'tb-scene-canvas';
    canvas.dataset.renderer = '3d'; canvas.dataset.engine = 'react-three-fiber';
    canvas.setAttribute('aria-label', props.locale === 'ru' ? 'Объёмный испытательный стенд' : 'Three-dimensional test bench');
    Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' }); surface.append(canvas);
    let alive = true; let renderer: T.WebGLRenderer;
    try { renderer = new T.WebGLRenderer({ canvas, antialias: props.quality !== 'low', alpha: false, powerPreference: 'high-performance' }); }
    catch { canvas.remove(); callback.current(); return; }
    const initialDpr = Math.min(window.devicePixelRatio || 1, props.quality === 'low' ? 1.25 : 2); let dpr = initialDpr;
    renderer.setPixelRatio(dpr);
    renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.20;
    renderer.shadowMap.enabled = props.quality !== 'low'; renderer.shadowMap.type = T.PCFSoftShadowMap;
    const scene = new T.Scene(); scene.background = new T.Color('#dce1d7'); scene.fog = new T.Fog('#dce1d7', 35, 85);
    // The rear camera looks along +Z. Reflect only presentation X so +X remains
    // screen-right, matching the plan view and keyboard/steering convention.
    // Three handles negative world determinants, including correct face winding.
    const world = new T.Group(); world.scale.x = props.mode === 'race' ? -1 : 1; scene.add(world);
    const particleMesh = new T.InstancedMesh(new T.SphereGeometry(.028, 5, 3), new T.MeshBasicMaterial({ color: '#a6b2aa', transparent: true, opacity: .58, depthWrite: false }), 36);
    particleMesh.count = 0; particleMesh.frustumCulled = false; world.add(particleMesh);
    const particles: { position: T.Vector3; velocity: T.Vector3; life: number }[] = [];
    const particleDummy = new T.Object3D(); let eventPrimer = false; const seenImpacts = new Set<string>(); let lastSpray = 0;
    const hemi = new T.HemisphereLight('#f8f5e9', '#788a80', 2.7); scene.add(hemi);
    const key = new T.DirectionalLight('#fff2d2', 3.2); key.position.set(-6, 12, -7); key.castShadow = props.quality !== 'low'; key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -10; key.shadow.camera.right = 10; key.shadow.camera.top = 14; key.shadow.camera.bottom = -14; key.shadow.normalBias = .03; key.shadow.bias = -.0003; scene.add(key, key.target);
    const fill = new T.DirectionalLight('#a8cad3', 1.1); fill.position.set(7, 5, 4); scene.add(fill);
    const camera = new T.OrthographicCamera(-8, 8, 5, -5, .05, 140);
    Object.assign(camera, { manual: true });
    const fiberRoot = createRoot(canvas); let fiberStore: RootStore | null = null;
    const target = new T.Vector3(); const desired = new T.Vector3(); const forward = new T.Vector3(); const targetQuat = new T.Quaternion();
    let width = 1, height = 1; let currentVehicle: Vehicle | null = null; let blueprintKey = ''; let carBuild = 0;
    let gates: T.Mesh[] = []; let slotTargets: T.Mesh[] = []; const cargo = new Map<string, { key: string; model: T.Group }>(); const cargoLoading = new Set<string>();
    const frames: number[] = []; let lastTime = 0; let metricTime = 0; let spin = 0;
    const recordBufferSize = () => {
      const context = renderer.getContext();
      canvas.dataset.quality = props.quality === 'low' ? 'low' : 'high';
      canvas.dataset.cssWidth = String(width); canvas.dataset.cssHeight = String(height);
      canvas.dataset.bufferWidth = String(context.drawingBufferWidth); canvas.dataset.bufferHeight = String(context.drawingBufferHeight);
      canvas.dataset.pixelRatio = String(renderer.getPixelRatio()); canvas.dataset.bufferPixelLimit = props.quality === 'low' ? '230400' : 'none';
    };
    const resize = () => {
      const box = surface.getBoundingClientRect(); width = Math.max(1, box.width); height = Math.max(1, box.height);
      dpr = props.quality === 'low' ? lowQualityPixelRatio(width, height, window.devicePixelRatio || 1) : initialDpr;
      const previousDpr = renderer.getPixelRatio();
      // Apply a shrinking ratio before enlarging the CSS size, and a growing
      // ratio after shrinking it, so resize does not allocate an oversized buffer.
      if (fiberStore) {
        const state = fiberStore.getState();
        if (dpr < previousDpr) state.setDpr(dpr);
        state.setSize(width, height, box.top, box.left);
        if (dpr > previousDpr) state.setDpr(dpr);
      } else {
        if (dpr < previousDpr) renderer.setPixelRatio(dpr);
        renderer.setSize(width, height, false);
        if (dpr > previousDpr) renderer.setPixelRatio(dpr);
      }
      // R3F synchronizes the backing buffer; the CSS canvas continues to fill its container.
      canvas.style.width = '100%'; canvas.style.height = '100%';
      recordBufferSize();
    };
    const observer = new ResizeObserver(resize); observer.observe(surface); resize();
    const onContextLost = (event: Event) => { event.preventDefault(); callback.current(); };
    canvas.addEventListener('webglcontextlost', onContextLost);
    const raycaster = new T.Raycaster();
    const onClick = (event: PointerEvent) => {
      if (latest.current.mode !== 'workshop' || !latest.current.onSlotSelect) return;
      const rect = canvas.getBoundingClientRect(); raycaster.setFromCamera(new T.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), camera);
      const hit = raycaster.intersectObjects(slotTargets)[0]; if (hit) latest.current.onSlotSelect(hit.object.userData.slot as SlotId);
    };
    canvas.addEventListener('pointerup', onClick);
    const synchronizeCargo = (lane: LaneSnapshot | null | undefined) => {
      const current = lane?.cargo ?? [];
      for (const item of current) {
        const state = item.status === 'broken' ? 'broken' : item.health < 80 ? 'damaged' : 'whole';
        const key = `cargo-${cargoModels[item.kind]}-${state}`;
        const previous = cargo.get(item.id);
        if (previous && previous.key !== key) { world.remove(previous.model); cargo.delete(item.id); }
        if (!cargo.has(item.id) && !cargoLoading.has(item.id)) {
          cargoLoading.add(item.id);
          void asset(key).then(model => { if (alive) { world.add(model); cargo.set(item.id, { key, model }); } }).catch(() => callback.current()).finally(() => cargoLoading.delete(item.id));
        }
        const loaded = cargo.get(item.id); if (!loaded) continue;
        loaded.model.visible = item.status !== 'deposited';
        const p = item.position; loaded.model.position.set(p.x, p.y, p.z);
        loaded.model.quaternion.set(item.rotation.x, item.rotation.y, item.rotation.z, item.rotation.w);
      }
      for (const [id, value] of cargo) if (!current.some(item => item.id === id)) { world.remove(value.model); cargo.delete(id); }
    };
    const updateCar = () => {
      const bp = latest.current.blueprint; const paint = participantPaint(latest.current.seatIndex, latest.current.participantId); const nextKey = JSON.stringify([bp, paint]);
      if (nextKey === blueprintKey) return;
      blueprintKey = nextKey; const build = ++carBuild;
      void vehicle(bp, paint).then(value => {
        if (!alive || build !== carBuild) { value.ownedMaterials.forEach(material => material.dispose()); return; }
        if (currentVehicle) { world.remove(currentVehicle.group); currentVehicle.ownedMaterials.forEach(material => material.dispose()); }
        currentVehicle = value; world.add(value.group);
      }).catch(() => callback.current());
    };
    void buildWorld(world, props).then(value => { if (alive) { gates = value.gates; slotTargets = value.slotTargets; setReady(true); } }).catch(() => { if (alive) callback.current(); });
    const render = (time: number) => {
      if (!alive) return;
      const state = latest.current; const dt = lastTime ? Math.min(.10, (time - lastTime) / 1000) : 1 / 60;
      if (lastTime) frames.push(time - lastTime); if (frames.length > 240) frames.shift(); lastTime = time;
      updateCar();
      const lane = state.lane; const race = state.mode === 'race';
      const carPos = lane?.car.position ?? { x: 0, y: 0, z: 0 };
      const aspect = width / height;
      const span = race ? Math.max(7.0, 5.8 / Math.max(.6, aspect)) : Math.max(2.9, 2.8 / Math.max(.6, aspect));
      camera.left = -span * aspect; camera.right = span * aspect; camera.top = span; camera.bottom = -span; camera.updateProjectionMatrix();
      const rotation = state.rotation ?? 0;
      const lookZ = race ? carPos.z + 3.6 : 0;
      target.set(race ? -carPos.x * .25 : 0, race ? Math.max(.1, groundHeight(state.track, carPos.x, lookZ)) : 0, lookZ);
      if (state.topView) desired.set(target.x, target.y + 22, target.z - .01);
      else if (race) desired.set(target.x + Math.sin(rotation) * 12, target.y + 15.36, target.z - Math.cos(rotation) * 12);
      else desired.set(target.x + Math.sin(rotation + .58) * 7, target.y + 5.7, target.z + Math.cos(rotation + .58) * 7);
      camera.position.lerp(desired, !lastTime || state.reducedMotion ? 1 : 1 - Math.exp(-dt * 8)); camera.lookAt(target);
      key.position.set(target.x - 6, target.y + 12, target.z - 7); key.target.position.copy(target);
      if (currentVehicle) {
        if (race && lane) {
          desired.set(carPos.x, carPos.y, carPos.z); currentVehicle.group.position.lerp(desired, state.reducedMotion ? 1 : 1 - Math.exp(-dt * 22));
          targetQuat.set(lane.car.rotation.x, lane.car.rotation.y, lane.car.rotation.z, lane.car.rotation.w); currentVehicle.group.quaternion.slerp(targetQuat, 1 - Math.exp(-dt * 22));
          forward.set(0, 0, 1).applyQuaternion(targetQuat);
          spin += (lane.car.velocity.x * forward.x + lane.car.velocity.y * forward.y + lane.car.velocity.z * forward.z) * dt;
          for (const wheel of currentVehicle.wheels) {
            const observed = lane.car.wheels[wheel.index];
            if (observed) {
              wheel.steer.position.y = observed.y - (wheel.index < 2 ? slots['front-axle'][1] : slots['rear-axle'][1]); wheel.steer.rotation.y = observed.steering; wheel.spin.rotation.x = spin / observed.radius;
              if (wheel.suspension) { const bottom = wheel.steer.position.y + .03; wheel.suspension.position.y = bottom; wheel.suspension.scale.y = Math.max(.12, .14 - bottom) / .21; }
            }
          }
          const cradle = currentVehicle.modules.get('cargo')?.getObjectByName('cargo-bed');
          if (cradle && state.blueprint.cargo === 'cradle') cradle.position.y = .16 + (state.reducedMotion ? 0 : Math.max(-.035, Math.min(.035, lane.car.velocity.y * -.02)));
          const clamp = currentVehicle.modules.get('cargo');
          if (clamp && state.blueprint.cargo === 'clamp') for (const side of ['left', 'right']) { const jaw = clamp.getObjectByName(`clamp-${side}`); if (jaw) jaw.rotation.z = lane.car.charge <= 0 ? (side === 'left' ? .55 : -.55) : 0; }
        } else {
          const frontRadius = PARTS[state.blueprint['front-axle']].radius!; const rearRadius = PARTS[state.blueprint['rear-axle']].radius!;
          currentVehicle.group.position.set(0, (frontRadius + rearRadius) / 2 - .23, 0);
          currentVehicle.group.rotation.set(Math.atan((rearRadius - frontRadius) / 1.6), 0, 0);
        }
      }
      synchronizeCargo(race ? lane : undefined);
      if (race && lane) {
        if (!eventPrimer) { lane.events.forEach(event => seenImpacts.add(event.id)); eventPrimer = true; }
        for (const event of lane.events) {
          if (seenImpacts.has(event.id)) continue;
          seenImpacts.add(event.id);
          if ((state.effects ?? true) && !state.reducedMotion && state.quality !== 'low' && event.kind === 'damaged') {
            for (let i = 0; i < 6; i++) {
              const angle = i * Math.PI / 3 + event.tick * .37;
              particles.push({ position: new T.Vector3(event.position.x + Math.cos(angle) * .6, event.position.y - .12, event.position.z + Math.sin(angle) * .6), velocity: new T.Vector3(Math.cos(angle) * .6, .65 + (i % 3) * .2, Math.sin(angle) * .6), life: .5 });
            }
          }
        }
        const wet = state.track.wet;
        if ((state.effects ?? true) && !state.reducedMotion && state.quality !== 'low' && wet && lane.car.speed > 1 && time - lastSpray > 85 && carPos.z >= wet.minZ && carPos.z <= wet.maxZ && carPos.x * wet.drySide < state.track.width / 2 - wet.dryWidth) {
          lastSpray = time;
          for (const side of [-1, 1]) particles.push({ position: new T.Vector3(carPos.x + side * .8, carPos.y - .15, carPos.z - .8), velocity: new T.Vector3(side * .25, .65, -.45), life: .42 });
        }
      }
      if (!(state.effects ?? true) || state.reducedMotion || state.quality === 'low') particles.length = 0;
      while (particles.length > 36) particles.shift();
      for (let i = particles.length - 1; i >= 0; i--) { const particle = particles[i]; particle.life -= dt; if (particle.life <= 0) particles.splice(i, 1); else { particle.velocity.y -= dt * 3; particle.position.addScaledVector(particle.velocity, dt); } }
      particleMesh.count = particles.length;
      particles.forEach((particle, i) => { particleDummy.position.copy(particle.position); particleDummy.scale.setScalar(Math.max(.1, particle.life * 3)); particleDummy.updateMatrix(); particleMesh.setMatrixAt(i, particleDummy.matrix); });
      particleMesh.instanceMatrix.needsUpdate = true;
      gates.forEach((gate, i) => { (gate.material as T.MeshBasicMaterial).color.set(i < (lane?.gatesPassed ?? 0) ? '#33b99e' : '#ffbd49'); });
      slotTargets.forEach(ring => {
        ring.visible = state.mode === 'workshop'; const selected = ring.userData.slot === state.selectedSlot;
        (ring.material as T.MeshBasicMaterial).color.set(selected ? '#ffbd49' : '#33b99e'); (ring.material as T.MeshBasicMaterial).opacity = selected ? 1 : .30; ring.scale.setScalar(selected ? 1.15 : 1);
        if (currentVehicle) { const point = slots[ring.userData.slot as SlotId]; ring.position.set(point[0], .52, point[2]).applyQuaternion(currentVehicle.group.quaternion).add(currentVehicle.group.position); ring.rotation.x = -Math.PI / 2 + currentVehicle.group.rotation.x; }
      });
      if (time - metricTime > 2000 && frames.length > 30) {
        recordBufferSize();
        metricTime = time; const sorted = [...frames].sort((a, b) => a - b); const metrics = { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frameP95Ms: sorted[Math.floor(sorted.length * .95)], renderer: '3d' as const };
        canvas.dataset.drawCalls = String(metrics.drawCalls); canvas.dataset.frameP95 = metrics.frameP95Ms.toFixed(2); state.onMetrics?.(metrics);
      }
    };
    void fiberRoot.configure({ gl: renderer, scene, camera, frameloop: 'always', dpr, shadows: props.quality !== 'low', size: { width, height, top: 0, left: 0 } }).then(() => {
      if (!alive) { fiberRoot.unmount(); return; }
      fiberStore = fiberRoot.render(<BenchFrame update={render} />); resize();
    }).catch(() => { if (alive) callback.current(); });
    return () => {
      alive = false; observer.disconnect(); canvas.removeEventListener('webglcontextlost', onContextLost); canvas.removeEventListener('pointerup', onClick);
      fiberRoot.unmount(); renderer.dispose(); canvas.remove();
      currentVehicle?.ownedMaterials.forEach(material => material.dispose());
      particleMesh.geometry.dispose(); (particleMesh.material as T.Material).dispose();
      scene.traverse(node => { if (node instanceof T.Mesh && node.material instanceof T.MeshBasicMaterial && node.material.map instanceof T.CanvasTexture) { node.material.map.dispose(); node.material.dispose(); node.geometry.dispose(); } });
    };
  // The mutable view is interpolated without recreating the renderer at snapshot frequency.
  }, [props.mode, props.track.id, props.track.mirrored, props.quality, props.locale]);
  return <><div ref={surfaceRef} style={{ display: 'block', width: '100%', height: '100%' }} />{!ready && <div className="tb-scene-loading" role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', color: '#263944' }}>{props.locale === 'ru' ? 'Готовим мастерскую…' : 'Preparing the workshop…'}</div>}</>;
}

function CanvasScene(props: TestBenchSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null); const latest = useRef(props);
  useEffect(() => { latest.current = props; });
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    let frame = 0; let width = 1; let height = 1; let currentScale = 1; let centerZ = 0;
    const resize = () => { const box = canvas.getBoundingClientRect(); width = box.width; height = box.height; const ratio = Math.min(window.devicePixelRatio || 1, 2); canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio)); context.setTransform(ratio, 0, 0, ratio, 0, 0); canvas.dataset.cssWidth = String(width); canvas.dataset.cssHeight = String(height); canvas.dataset.bufferWidth = String(canvas.width); canvas.dataset.bufferHeight = String(canvas.height); canvas.dataset.pixelRatio = String(ratio); canvas.dataset.bufferPixelLimit = 'none'; canvas.dataset.quality = 'not-applicable'; };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const pos = (x: number, z: number): [number, number] => [width / 2 + x * currentScale, height * .66 - (z - centerZ) * currentScale];
    const slotPoint = (slot: SlotId): [number, number] => { const [x, , z] = slots[slot]; const angle = latest.current.rotation ?? 0; return pos(x * Math.cos(angle) + z * Math.sin(angle), z * Math.cos(angle) - x * Math.sin(angle)); };
    const line = (x1: number, z1: number, x2: number, z2: number, color: string, stroke: number) => { context.strokeStyle = color; context.lineWidth = stroke; context.beginPath(); context.moveTo(...pos(x1, z1)); context.lineTo(...pos(x2, z2)); context.stroke(); };
    const rect = (x: number, z: number, w: number, d: number, color: string) => { const [px, py] = pos(x, z); context.fillStyle = color; context.fillRect(px - w * currentScale / 2, py - d * currentScale / 2, w * currentScale, d * currentScale); };
    const draw = () => {
      const state = latest.current; const { track, lane, mode } = state;
      const race = mode === 'race'; currentScale = race ? Math.min(width / 9.5, height / 14) : Math.min(width / 5.4, height / 4.5); centerZ = race ? lane?.car.position.z ?? 0 : -.4;
      context.fillStyle = '#dce1d7'; context.fillRect(0, 0, width, height);
      if (race) {
        rect(0, 24, 7.2, 58, '#d9d5c8');
        for (let z = -5; z <= 53; z += 1) { const elevation = groundHeight(track, 0, z); if (elevation > .1) rect(0, z, 7.2, 1, `rgb(${217 - elevation * 7},${213 - elevation * 5},${200 - elevation * 4})`); }
        if (track.ramp) {
          for (const z of [track.ramp.start, track.ramp.end, track.ramp.downStart, track.ramp.downEnd]) if (z !== undefined) line(-3.6, z, 3.6, z, '#8c988f', 2);
          if (track.ramp.bevel) for (const z of [track.ramp.start + track.ramp.bevel, track.ramp.end - track.ramp.bevel]) line(-3.6, z, 3.6, z, '#b5bdb1', 1);
        }
        if (track.wet) rect(-track.wet.drySide * track.wet.dryWidth / 2, (track.wet.minZ + track.wet.maxZ) / 2, track.width - track.wet.dryWidth, track.wet.maxZ - track.wet.minZ, '#638a91');
        for (const rib of track.ribs) {
          line(-rib.smoothSide * .7 - 2.9, rib.z, -rib.smoothSide * .7 + 2.9, rib.z, '#a0a59a', Math.max(3, currentScale * .13));
          line(rib.smoothSide * 3.075 - .525, rib.z, rib.smoothSide * 3.075 + .525, rib.z, '#c2c8bb', Math.max(1, currentScale * .025));
        }
        if (track.id === 'precision') for (const gate of track.orderedGates) for (const side of [-1, 1]) {
          const edge = gate.x + side * gate.width / 2; const wall = side * track.width / 2;
          rect((edge + wall) / 2, gate.z, Math.abs(wall - edge), .24, '#263944');
          line(edge, gate.z, wall, gate.z, '#ffbd49', Math.max(2, currentScale * .055));
        }
        line(-3.6, -5, -3.6, 53, '#f4f1e9', 8); line(3.6, -5, 3.6, 53, '#f4f1e9', 8);
        const unload = track.unload; rect((unload.minX + unload.maxX) / 2, (unload.minZ + unload.maxZ) / 2, unload.maxX - unload.minX, unload.maxZ - unload.minZ, '#33b99e');
        track.orderedGates.forEach((gate, i) => { const color = i < (lane?.gatesPassed ?? 0) ? '#33b99e' : '#ffbd49'; line(gate.x - gate.width / 2, gate.z, gate.x + gate.width / 2, gate.z, color, 6); context.fillStyle = '#263944'; context.font = '600 16px "Golos Text",sans-serif'; context.textAlign = 'center'; const [x, y] = pos(gate.x - gate.width / 2, gate.z); context.fillText(String(i + 1), x - 14, y + 5); });
        context.strokeStyle = '#b5801d'; context.lineWidth = 3; context.beginPath(); context.arc(...pos(track.loadingDock.x, track.loadingDock.z), currentScale * track.loadingDock.radius, 0, Math.PI * 2); context.stroke();
        context.font = '600 12px "Golos Text",sans-serif'; context.fillStyle = '#263944'; context.textAlign = 'center'; const dock = pos(0, track.loadingDock.z - 1.4); context.fillText(state.locale === 'ru' ? 'ЗАГРУЗКА' : 'LOAD', dock[0], dock[1]);
        const finish = pos(0, (unload.minZ + unload.maxZ) / 2); context.fillText(state.locale === 'ru' ? 'СДАЧА ГРУЗА' : 'UNLOAD', finish[0], finish[1]);
      } else {
        rect(0, 0, 4.8, 4.1, '#e6dcc4'); rect(0, 0, 3.6, 3.6, '#a7b4a5');
        for (let p = -1.8; p <= 1.8; p += .2) { line(p, -1.8, p, 1.8, '#c2cebb', 1); line(-1.8, p, 1.8, p, '#c2cebb', 1); }
      }
      const car = lane?.car; const carPoint = race && car ? pos(car.position.x, car.position.z) : pos(0, 0);
      context.save(); context.translate(...carPoint); context.rotate(race ? car?.yaw ?? 0 : state.rotation ?? 0);
      const s = currentScale; const bp = state.blueprint;
      context.shadowColor = '#26394444'; context.shadowBlur = 8; context.shadowOffsetY = 5;
      context.fillStyle = participantPaint(state.seatIndex, state.participantId); context.beginPath(); context.roundRect(-.65 * s, -1.02 * s, 1.3 * s, 2.0 * s, .12 * s); context.fill(); context.shadowBlur = 0; context.shadowOffsetY = 0;
      context.strokeStyle = '#f4f1e9'; context.lineWidth = .07 * s; context.stroke();
      const axleRadius = (id: string) => id === 'high' ? .32 : id === 'terrain' ? .27 : .23;
      for (const side of [-1, 1]) for (const front of [true, false]) {
        const r = axleRadius(bp[front ? 'front-axle' : 'rear-axle']); context.save(); context.translate(side * .8 * s, (front ? -.8 : .8) * s); if (front) context.rotate(car?.wheels[0]?.steering ?? 0); context.fillStyle = '#263944'; context.beginPath(); context.roundRect(-.13 * s, -r * s, .26 * s, r * 2 * s, .06 * s); context.fill(); context.strokeStyle = '#a9bac1'; context.lineWidth = .06 * s; context.beginPath(); context.moveTo(-.12 * s, 0); context.lineTo(.12 * s, 0); context.stroke(); context.restore();
      }
      context.fillStyle = bp.cargo === 'cradle' ? '#f4f1e9' : bp.cargo === 'clamp' ? '#638a91' : '#be9c6f'; context.fillRect(-.58 * s, -.32 * s, 1.16 * s, .70 * s);
      for (const x of [-.42, 0, .42]) { context.fillStyle = '#263944'; context.beginPath(); context.arc(x * s, .12 * s, .13 * s, 0, Math.PI * 2); context.fill(); }
      context.fillStyle = '#263944'; context.fillRect(-.23 * s, .56 * s, .46 * s, .28 * s); context.fillStyle = '#33b99e'; context.fillRect(-.15 * s, .62 * s, .30 * s * Math.max(0, (car?.charge ?? 47) / (bp.battery === 'large' ? 47 : 29)), .12 * s);
      context.fillStyle = bp.motor === 'torque' ? '#638a91' : bp.motor === 'speed' ? '#d95b50' : '#33b99e'; context.fillRect(-.22 * s, -.71 * s, .44 * s, .22 * s);
      if (bp['aux-left']) { context.fillStyle = '#638a91'; context.fillRect(-.69 * s, -.2 * s, .18 * s, .4 * s); }
      if (bp['aux-right']) { context.fillStyle = '#638a91'; context.fillRect(.51 * s, -.2 * s, .18 * s, .4 * s); }
      context.restore();
      if (race && lane) for (const item of lane.cargo) {
        if (item.status === 'deposited') continue;
        const [x, y] = pos(item.position.x, item.position.z); const radius = Math.max(5, .13 * s);
        context.fillStyle = item.status === 'broken' ? '#d95b50' : item.health < 80 ? '#e9a88c' : item.kind === 'egg' ? '#f4f1e9' : item.kind === 'instrument' ? '#638a91' : '#33b99e';
        context.strokeStyle = '#263944'; context.lineWidth = 1.5;
        if (item.kind === 'instrument') { context.fillRect(x - radius, y - radius, radius * 2, radius * 2); context.strokeRect(x - radius, y - radius, radius * 2, radius * 2); }
        else { context.beginPath(); context.ellipse(x, y, radius, radius * (item.kind === 'egg' ? 1.3 : 1), 0, 0, Math.PI * 2); context.fill(); context.stroke(); }
        if (item.health < 80) { context.beginPath(); context.moveTo(x - radius / 2, y - radius); context.lineTo(x + radius / 3, y); context.lineTo(x - radius / 4, y + radius); context.stroke(); }
      }
      if (!race && state.selectedSlot) { const point = slotPoint(state.selectedSlot); context.strokeStyle = '#e8a326'; context.lineWidth = 4; context.beginPath(); context.arc(...point, s * .23, 0, Math.PI * 2); context.stroke(); }
      frame = requestAnimationFrame(draw);
    };
    const onPointer = (event: PointerEvent) => {
      if (latest.current.mode !== 'workshop' || !latest.current.onSlotSelect) return;
      const bounds = canvas.getBoundingClientRect(); const x = event.clientX - bounds.left; const y = event.clientY - bounds.top;
      const nearest = (Object.keys(slots) as SlotId[]).map(slot => { const [px, py] = slotPoint(slot); return { slot, distance: Math.hypot(x - px, y - py) }; }).sort((a, b) => a.distance - b.distance)[0];
      if (nearest.distance < currentScale * .45) latest.current.onSlotSelect(nearest.slot);
    };
    canvas.addEventListener('pointerup', onPointer); frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); canvas.removeEventListener('pointerup', onPointer); };
  }, []);
  return <canvas ref={canvasRef} className="tb-scene-canvas" data-renderer="2d" aria-label={props.locale === 'ru' ? 'Схема испытательного стенда' : 'Test bench plan view'} style={{ display: 'block', width: '100%', height: '100%', touchAction: 'none' }} />;
}

export function TestBenchScene(props: TestBenchSceneProps) {
  const [lost, setLost] = useState(false);
  const use2d = props.renderer === '2d' || lost;
  return <div className="tb-scene" data-scene-mode={props.mode} data-scene-renderer={use2d ? '2d' : '3d'} data-participant-paint={participantPaint(props.seatIndex, props.participantId)} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 160, overflow: 'hidden' }}>
    {use2d ? <CanvasScene {...props} /> : <ThreeScene {...props} onFailure={() => setLost(true)} />}
    {lost && props.renderer !== '2d' && <button type="button" className="tb-restore-renderer" onClick={() => setLost(false)} style={{ position: 'absolute', top: 8, left: 8, zIndex: 4 }}>{props.locale === 'ru' ? 'Вернуть 3D' : 'Restore 3D'}</button>}
    {props.mode === 'workshop' && props.selectedSlot && <div className="tb-scene-slot-label" aria-live="polite" style={{ position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)', color: '#263944', background: '#f4f1e9e8', borderRadius: 6, padding: '6px 12px', fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap' }}>{SLOT_NAMES[props.selectedSlot][props.locale]}</div>}
  </div>;
}

/** A faithful top-down drawing of the same route data used by physics and scoring. */
export function TrackDiagram({ track, locale, className }: { track: TrackDefinition; locale: Locale; className?: string }) {
  const x = (value: number) => 60 + value * 10; const y = (value: number) => 495 - value * 9.5;
  return <svg className={className} viewBox="0 0 120 530" role="img" aria-label={track.name[locale]}>
    <rect x="20" y="12" width="80" height="506" rx="9" fill="#d9d5c8" stroke="#a7b0a5" strokeWidth="2" />
    <path d="M24 500V25M96 500V25" stroke="#f4f1e9" strokeWidth="3" strokeDasharray="8 5" />
    {track.ramp && <rect x="24" y={y(track.ramp.downEnd ?? 49)} width="72" height={y(track.ramp.start) - y(track.ramp.downEnd ?? 49)} fill="#b5bcb0" />}
    {track.ramp?.bevel && [track.ramp.start + track.ramp.bevel, track.ramp.end - track.ramp.bevel].map(z => <path key={z} d={`M24,${y(z)}h72`} stroke="#8c988f" strokeWidth="1" />)}
    {track.wet && <rect x={track.wet.drySide === 1 ? 24 : 24 + track.wet.dryWidth * 10} y={y(track.wet.maxZ)} width={(track.width - track.wet.dryWidth) * 10} height={(track.wet.maxZ - track.wet.minZ) * 9.5} fill="#638a91" />}
    {track.ribs.map(rib => <path key={rib.z} d={`M${rib.smoothSide === 1 ? 24 : 38},${y(rib.z)}h58`} stroke="#a0a59a" strokeWidth="4" />)}
    <rect x={x(track.unload.minX)} y={y(track.unload.maxZ)} width={(track.unload.maxX - track.unload.minX) * 10} height={(track.unload.maxZ - track.unload.minZ) * 9.5} rx="3" fill="#33b99e" />
    {track.orderedGates.map((gate, i) => <g key={gate.id}><path d={`M${x(gate.x - gate.width / 2)},${y(gate.z)}h${gate.width * 10}`} stroke="#e7a224" strokeWidth="5" /><text x={x(gate.x)} y={y(gate.z) - 7} textAnchor="middle" fill="#263944" fontSize="12" fontWeight="700">{i + 1}</text></g>)}
    <circle cx={x(track.loadingDock.x)} cy={y(track.loadingDock.z)} r="10" fill="none" stroke="#e7a224" strokeWidth="3" />
    <path d="m60 489-7 11h14z" fill="#263944" />
  </svg>;
}

export default TestBenchScene;
