import * as THREE from 'three';
import type { MapId, MaterialId, Surface } from '../core/types';

/** Original Tyaga material source. No downloaded image or runtime CDN input. */
export const TERRAIN_ART_VERSION = 'tyaga-terrain@1';
export type TerrainKind = MaterialId | 'rock';
type TerrainTexture = { color: THREE.DataTexture; detail: THREE.DataTexture };
type Disposable = THREE.Material | THREE.Texture;

const TAU = Math.PI * 2;
const SIZE = 256;
const PALETTE: Record<TerrainKind, [number, number, number]> = {
  soil: [157, 143, 108], stone: [151, 166, 155], 'wet-stone': [101, 126, 126],
  mud: [112, 98, 72], wood: [155, 119, 72], steel: [88, 112, 118],
  ice: [160, 196, 198], rock: [107, 131, 119],
};
const METRES: Record<TerrainKind, number> = { soil: 3, stone: 2.6, 'wet-stone': 2.6, mud: 2.4, wood: 2, steel: 1.2, ice: 3.5, rock: 3 };
const ROUGHNESS: Record<TerrainKind, number> = { soil: .99, stone: .96, 'wet-stone': .67, mud: .82, wood: .94, steel: .72, ice: .38, rock: .99 };
const SEEDS: Record<TerrainKind, number> = { soil: 17, stone: 31, 'wet-stone': 31, mud: 53, wood: 71, steel: 89, ice: 97, rock: 109 };
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const smooth = (min: number, max: number, value: number) => { const t = clamp((value - min) / (max - min)); return t * t * (3 - 2 * t); };
const fract = (value: number) => value - Math.floor(value);
function hash(x: number, y: number, seed: number) {
  let n = Math.imul(x + seed * 101, 374761393) ^ Math.imul(y + seed * 17, 668265263);
  n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967295;
}
function periodicNoise(cells: number, seed: number) {
  const values = Float32Array.from({ length: cells * cells }, (_, i) => hash(i % cells, Math.floor(i / cells), seed));
  return (u: number, v: number) => {
    const x = fract(u) * cells, y = fract(v) * cells, a = Math.floor(x), b = Math.floor(y), tx = smooth(0, 1, x - a), ty = smooth(0, 1, y - b);
    const sample = (i: number, j: number) => values[(j % cells) * cells + i % cells];
    const first = THREE.MathUtils.lerp(sample(a, b), sample(a + 1, b), tx), second = THREE.MathUtils.lerp(sample(a, b + 1), sample(a + 1, b + 1), tx);
    return THREE.MathUtils.lerp(first, second, ty);
  };
}
function mineralCracks(seed: number) {
  const segments: { x: number; y: number; dx: number; dy: number; length2: number }[] = [];
  const add = (x: number, y: number, dx: number, dy: number) => segments.push({ x: x + dx / 2, y: y + dy / 2, dx, dy, length2: dx * dx + dy * dy });
  for (let path = 0; path < 7; path++) {
    let x = hash(path, 3, seed), y = hash(path, 7, seed), angle = hash(path, 11, seed) * TAU;
    for (let step = 0; step < 3; step++) {
      angle += (hash(path, step + 15, seed) - .5) * .85;
      const length = .04 + hash(path, step + 22, seed) * .065, dx = Math.cos(angle) * length, dy = Math.sin(angle) * length;
      add(x, y, dx, dy);
      if (step === 1 && path % 2 === 0) add(x, y, Math.cos(angle + .75) * .055, Math.sin(angle + .75) * .055);
      x += dx; y += dy;
    }
  }
  return (u: number, v: number) => {
    let closest = 1;
    for (const segment of segments) {
      let x = u - segment.x, y = v - segment.y; x -= Math.round(x); y -= Math.round(y);
      const t = clamp((x * segment.dx + y * segment.dy) / segment.length2, -.5, .5);
      const dx = x - t * segment.dx, dy = y - t * segment.dy; closest = Math.min(closest, dx * dx + dy * dy);
    }
    return 1 - smooth(.0008, .0032, Math.sqrt(closest));
  };
}

/** 256² seamless albedo plus a shared roughness/height channel, in linear-size metres. */
export function terrainPixels(kind: TerrainKind, size = SIZE) {
  const color = new Uint8Array(size * size * 4), detail = new Uint8Array(size * size * 4), seed = SEEDS[kind];
  const cloud = periodicNoise(4, seed), grain = periodicNoise(13, seed + 1), fleck = periodicNoise(47, seed + 2);
  const cracks = kind === 'stone' || kind === 'wet-stone' || kind === 'rock' || kind === 'ice' ? mineralCracks(seed) : null;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, coarse = cloud(u, v), fine = grain(u, v), small = fleck(u, v), dust = hash(x, y, seed);
    let shade = 1 + (coarse - .5) * .23 + (fine - .5) * .13 + (dust - .5) * .045;
    let relief = .8 + fine * .12 + small * .07;
    if (kind === 'soil' || kind === 'mud') {
      const pebbles = smooth(.72, .89, small), soilGrain = (dust - .5) * .09;
      shade += pebbles * .18 + soilGrain;
      if (kind === 'mud') { const damp = smooth(.42, .77, coarse); shade -= damp * .16; relief -= damp * .22; }
      relief += pebbles * .08;
    } else if (kind === 'stone' || kind === 'wet-stone' || kind === 'rock') {
      const fracture = cracks!(u, v);
      shade -= fracture * .17; shade += smooth(.76, .94, small) * .17; relief -= fracture * .14;
      if (kind === 'rock') {
        const strata = Math.sin(TAU * (v * 3 + coarse * .18 + .035 * Math.sin(u * TAU * 2)));
        shade += strata * .06; relief += strata * .025;
      } else if (kind === 'wet-stone') { const damp = smooth(.3, .8, coarse); shade -= damp * .09; relief -= damp * .2; }
    } else if (kind === 'wood') {
      const row = Math.floor(v * 8), across = fract(v * 8), along = fract(u + row % 2 * .5);
      const seam = Math.min(across, 1 - across) < .025 || Math.min(along, 1 - along) < .0045;
      const fibres = Math.sin(TAU * (v * 96 + .19 * Math.sin(u * TAU * 2) + coarse * .12));
      shade = .95 + hash(row, 0, seed) * .14 + (fine - .5) * .07 + fibres * .045;
      relief = .88 + fibres * .025;
      if (seam) { shade *= .6; relief = .58; }
      const nailX = Math.min(Math.abs(along - .035), Math.abs(along - .965)), nailY = Math.min(Math.abs(across - .18), Math.abs(across - .82));
      if (Math.hypot(nailX / .007, nailY / .045) < 1) { shade = .38; relief = .83; }
    } else if (kind === 'steel') {
      const seam = Math.min(u, 1 - u, v, 1 - v) < .007;
      const a = fract((u + v) * 8), b = fract((u - v) * 8), grip = Math.min(a, 1 - a, b, 1 - b) < .07;
      shade = 1 + (coarse - .5) * .09 + (dust - .5) * .035 + (grip ? .08 : 0);
      relief = grip ? .99 : .82;
      if (seam) { shade *= .69; relief = .65; }
      if (Math.hypot(Math.min(Math.abs(u - .07), Math.abs(u - .93)), Math.min(Math.abs(v - .07), Math.abs(v - .93))) < .012) { shade = .52; relief = .9; }
    } else if (kind === 'ice') {
      const frost = smooth(.52, .84, fine), vein = cracks!(u, v);
      shade += frost * .13 + vein * .1; relief = .62 + frost * .31;
    }
    const i = (y * size + x) * 4;
    for (let channel = 0; channel < 3; channel++) { color[i + channel] = Math.round(clamp(PALETTE[kind][channel] * shade, 0, 255)); detail[i + channel] = Math.round(clamp(relief) * 255); }
    color[i + 3] = detail[i + 3] = 255;
  }
  return { color, detail };
}

function texture(bytes: Uint8Array, color: boolean, anisotropy: number) {
  const result = new THREE.DataTexture(bytes, SIZE, SIZE, THREE.RGBAFormat);
  result.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  result.wrapS = result.wrapT = THREE.RepeatWrapping; result.magFilter = THREE.LinearFilter;
  result.minFilter = THREE.LinearMipmapLinearFilter; result.generateMipmaps = true; result.anisotropy = anisotropy; result.needsUpdate = true;
  return result;
}

/** This only writes UVs. World vertices and collider envelopes remain untouched. */
export function terrainUVs(geometry: THREE.BufferGeometry, surface: Surface) {
  const kind: TerrainKind = surface.kind === 'rock' ? 'rock' : surface.material, scale = 1 / METRES[kind];
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = new Float32Array(position.count * 2);
  const rotation = new THREE.Quaternion(surface.rotation.x, surface.rotation.y, surface.rotation.z, surface.rotation.w);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    p.fromBufferAttribute(position, i).applyQuaternion(rotation).add(surface.position); n.fromBufferAttribute(normal, i).applyQuaternion(rotation);
    if (Math.abs(n.y) >= Math.max(Math.abs(n.x), Math.abs(n.z))) { uv[i * 2] = p.x * scale; uv[i * 2 + 1] = p.z * scale; }
    else if (Math.abs(n.x) > Math.abs(n.z)) { uv[i * 2] = p.z * scale; uv[i * 2 + 1] = p.y * scale; }
    else { uv[i * 2] = p.x * scale; uv[i * 2 + 1] = p.y * scale; }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Shared small texture pairs; one existing draw call per terrain surface. */
export class TerrainMaterials {
  private textures = new Map<TerrainKind, TerrainTexture>();
  constructor(private map: MapId, private low: boolean, private anisotropy: number, private own: (resource: Disposable) => void) {}
  material(surface: Surface) {
    const kind: TerrainKind = surface.kind === 'rock' ? 'rock' : surface.material;
    let pair = this.textures.get(kind);
    if (!pair) {
      const pixels = terrainPixels(kind); pair = { color: texture(pixels.color, true, this.anisotropy), detail: texture(pixels.detail, false, this.anisotropy) };
      this.textures.set(kind, pair); this.own(pair.color); this.own(pair.detail);
    }
    const tint = kind === 'rock' ? this.map === 'ridge' ? '#dde6ee' : this.map === 'quarry' ? '#dfebea' : '#eef0db' : '#ffffff';
    const material = new THREE.MeshStandardMaterial({ color: tint, map: pair.color, roughnessMap: pair.detail,
      roughness: ROUGHNESS[kind], metalness: kind === 'steel' ? .55 : kind === 'ice' ? .05 : 0,
      bumpMap: this.low ? null : pair.detail, bumpScale: kind === 'wood' || kind === 'steel' ? .012 : .021 });
    material.name = `${TERRAIN_ART_VERSION}/${kind}`; this.own(material);
    // Pads are the base; a road owns its coplanar pavement. This does not move
    // either mesh away from the actual collision shape.
    if (surface.kind === 'pad') { material.polygonOffset = true; material.polygonOffsetFactor = 1; material.polygonOffsetUnits = 1; }
    const halfSize = new THREE.Vector3(surface.size.x, surface.size.y, surface.size.z).multiplyScalar(.5);
    const edges = new THREE.Vector2(surface.kind === 'road' ? 0 : 1, 1).multiplyScalar(surface.mesh ? 0 : 1);
    material.customProgramCacheKey = () => TERRAIN_ART_VERSION;
    material.onBeforeCompile = shader => {
      shader.uniforms.tyHalfSize = { value: halfSize }; shader.uniforms.tyEdgeAxes = { value: edges }; shader.uniforms.tyRock = { value: kind === 'rock' ? 1 : 0 };
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTyPosition;\nvarying vec3 vTyNormal;\nvarying vec3 vTyWorld;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTyPosition = position;\nvTyNormal = normal;\nvTyWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTyPosition;\nvarying vec3 vTyNormal;\nvarying vec3 vTyWorld;\nuniform vec3 tyHalfSize;\nuniform vec2 tyEdgeAxes;\nuniform float tyRock;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          float tyTop = smoothstep( 0.45, 0.85, vTyNormal.y );
          float tyX = mix( 1000.0, max( 0.0, tyHalfSize.x - abs( vTyPosition.x ) ), tyEdgeAxes.x );
          float tyZ = mix( 1000.0, max( 0.0, tyHalfSize.z - abs( vTyPosition.z ) ), tyEdgeAxes.y );
          float tyBorder = min( tyX, tyZ );
          float tyWeather = 0.5 + 0.22 * sin( vTyWorld.x * 2.3 + sin( vTyWorld.z * 1.7 ) ) + 0.18 * sin( vTyWorld.z * 5.4 + vTyWorld.x );
          float tyShoulder = ( 1.0 - smoothstep( 0.02, 0.16 + tyWeather * 0.10, tyBorder ) ) * tyTop;
          float tyRim = ( 1.0 - smoothstep( 0.0, 0.025, tyBorder ) ) * tyTop;
          float tySideRim = ( 1.0 - smoothstep( 0.0, 0.12, max( 0.0, tyHalfSize.y - vTyPosition.y ) ) ) * ( 1.0 - tyTop );
          float tyDepth = clamp( ( vTyPosition.y + tyHalfSize.y ) / max( 1.0, 2.0 * tyHalfSize.y ), 0.0, 1.0 );
          diffuseColor.rgb *= 1.0 - tyShoulder * 0.12 + tyRim * 0.09 + tySideRim * 0.06;
          diffuseColor.rgb *= mix( 1.0, 0.82 + 0.18 * tyDepth, tyRock );
        `);
    };
    return material;
  }
}
