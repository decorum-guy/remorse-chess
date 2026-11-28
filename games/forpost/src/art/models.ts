/** Original Forpost model presentation. Authoritative geometry remains in the rules core. */
import { Color, Mesh, MeshStandardMaterial, Object3D, CircleGeometry, MeshBasicMaterial, Vector3 } from 'three';

export type ForpostModelId = 'fighter-carbine' | 'fighter-shotgun' | 'fighter-rifle' | 'builder' | 'drone' | 'transport' | 'relay' | 'generator' | 'extractor' | 'turret' | 'dock' | 'battery' | 'respawn' | 'bridge' | 'foundation' | 'wall' | 'wall-destructible' | 'station' | 'complex' | 'ground-concrete' | 'ground-sand' | 'ground-industrial' | 'water' | 'target' | 'depot' | 'crane';
export interface ForpostModelState {
  team?: 'A' | 'B';
  powered?: boolean;
  healthRatio?: number;
  selected?: boolean;
  ghost?: boolean;
}
export interface ForpostAnimationState {
  /** Presentation time in seconds. It never advances gameplay. */
  time: number;
  moving?: boolean;
  distance?: number;
  working?: boolean;
  powered?: boolean;
  turretYaw?: number;
  /** Seconds since the confirmed fire event; absent means no recoil. */
  sinceShot?: number;
  unloading?: boolean;
  /** Normalized confirmed death/destruction progress; collision is already removed by rules. */
  destroyProgress?: number;
  reducedMotion?: boolean;
  constructionProgress?: number;
  captureProgress?: number;
  reloadProgress?: number;
  suppressed?: boolean;
  sinceHit?: number;
}
const TEAM = { A: new Color('#47c9e5'), B: new Color('#ffb25b') };
const ARMOUR = new Color('#29404a');
const NEUTRAL = new Color('#d6cba4');
const WHITE = new Color('#ffffff');
const MEMORY = new Color('#829090');
const SCORCH = new Color('#372b29');

export function forpostAssetUrl(baseUrl: string, path: string): string {
  return `${baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`}assets/forpost/${path}`;
}
export function forpostModelUrl(baseUrl: string, id: ForpostModelId, quality: 'standard' | 'low' = 'standard'): string {
  return forpostAssetUrl(baseUrl, `models/${id}${quality === 'low' ? '-low' : ''}.glb`);
}

/** Clone mutable materials per entity; geometry stays shared. */
export function cloneForpostModel(template: Object3D, state: ForpostModelState = {}): Object3D {
  const model = template.clone(true);
  model.traverse((node) => {
    node.userData.forpostBasePosition = node.position.clone();
    node.userData.forpostBaseRotation = node.rotation.clone();
    if (node instanceof Mesh) {
      const originals = Array.isArray(node.material) ? node.material : [node.material];
      const clones = originals.map((m) => {
        const clone = m.clone();
        if (clone instanceof MeshStandardMaterial) {
          clone.userData.forpostOriginalColor = clone.color.clone();
          clone.userData.forpostOriginalRoughness = clone.roughness;
        }
        return clone;
      });
      node.material = Array.isArray(node.material) ? clones : clones[0]!;
      node.castShadow = true;
      node.receiveShadow = true;
    }
  });
  model.userData.forpostBaseScale = model.scale.clone();
  applyForpostModelState(model, state);
  return model;
}

export function applyForpostModelState(model: Object3D, state: ForpostModelState): void {
  const tint = state.team ? TEAM[state.team] : NEUTRAL;
  const damage = 1 - Math.min(1, Math.max(0, state.healthRatio ?? 1));
  model.traverse((node) => {
    if (node.name.startsWith('Team_A_Insignia')) node.visible = state.team === 'A';
    if (node.name.startsWith('Team_B_Insignia')) node.visible = state.team === 'B';
    if (!(node instanceof Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!(material instanceof MeshStandardMaterial)) continue;
      const originalColor = material.userData.forpostOriginalColor as Color | undefined;
      if (originalColor) material.color.copy(originalColor);
      if (material.userData.forpostOriginalRoughness !== undefined) material.roughness = material.userData.forpostOriginalRoughness;
      if (material.name.startsWith('FP_Team')) material.color.copy(tint).lerp(SCORCH, damage * .22);
      if (material.name.startsWith('FP_Signal')) {
        material.color.copy(state.powered === false ? ARMOUR : tint);
        material.emissive.copy(tint);
        material.emissiveIntensity = state.powered === false || state.ghost ? 0 : 1.2;
      }
      if (material.name.startsWith('FP_Armour') || material.name.startsWith('FP_Baked')) {
        material.color.copy(material.name.startsWith('FP_Baked') ? WHITE : ARMOUR).lerp(SCORCH, damage * .65);
        material.roughness = .62 + damage * .25;
      }
      if (material.name.startsWith('FP_Team')) {
        material.emissive.copy(tint);
        material.emissiveIntensity = state.selected && !state.ghost ? .2 : 0;
      }
      material.transparent = !!state.ghost;
      material.opacity = state.ghost ? .32 : 1;
      material.depthWrite = !state.ghost;
      if (state.ghost) material.color.lerp(MEMORY, .8);
      if (material.name.startsWith('FP_Signal')) {
        material.userData.forpostEmissive = material.emissive.clone();
        material.userData.forpostEmissiveIntensity = material.emissiveIntensity;
      }
    }
  });
}

/** Shape repeats team color for colour-blind readability. Add outside the entity's body collider. */
export function makeForpostTeamMarker(team: 'A' | 'B', radius: number): Mesh {
  const marker = new Mesh(new CircleGeometry(radius, team === 'A' ? 3 : 6), new MeshBasicMaterial({ color: TEAM[team], transparent: true, opacity: .7, depthWrite: false }));
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = .018;
  marker.name = `ForpostTeam${team}Marker`;
  return marker;
}

/** Named mechanical parts move only from real entity state and confirmed event timing. */
export function animateForpostModel(model: Object3D, state: ForpostAnimationState): void {
  const moving = state.moving && !state.reducedMotion;
  const working = state.working && state.powered !== false && !state.reducedMotion;
  const recoil = state.sinceShot !== undefined && state.sinceShot >= 0 && state.sinceShot < .14 && !state.reducedMotion
    ? Math.sin(Math.PI * state.sinceShot / .14) : 0;
  model.traverse((node) => {
    const p = node.userData.forpostBasePosition as Vector3 | undefined;
    if (node.name === 'leg_left') node.rotation.x = moving ? Math.sin(state.time * 12) * .38 : 0;
    if (node.name === 'leg_right') node.rotation.x = moving ? -Math.sin(state.time * 12) * .38 : 0;
    if (node.name.startsWith('wheel_')) node.rotation.x = -(state.distance ?? (moving ? state.time * 2 : 0)) / .12;
    if (node.name.startsWith('rotor_')) node.rotation.z = working ? state.time * 4 : 0;
    if (node.name === 'piston' && p) node.position.y = p.y + (working ? Math.sin(state.time * 4) * .13 : 0);
    if (node.name === 'arm') node.rotation.x = working ? Math.sin(state.time * 5) * .17 : 0;
    if (node.name === 'turret' && state.turretYaw !== undefined) node.rotation.y = state.turretYaw;
    if (node.name === 'weapon' && p) {
      node.position.z = p.z + recoil * .055;
      node.rotation.z = state.reloadProgress !== undefined && !state.reducedMotion ? Math.sin(Math.PI * state.reloadProgress) * .3 : 0;
    }
    if (node instanceof Mesh) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!(material instanceof MeshStandardMaterial) || !material.name.startsWith('FP_Signal')) continue;
        const baseEmissive = material.userData.forpostEmissive as Color | undefined;
        if (state.suppressed) material.emissive.set('#f06b66');
        else if (baseEmissive) material.emissive.copy(baseEmissive);
        material.emissiveIntensity = state.captureProgress !== undefined
          ? .25 + Math.min(1, Math.max(0, state.captureProgress))
          : material.userData.forpostEmissiveIntensity ?? 0;
      }
    }
    if (node.name === 'energy_container' && p) node.position.y = p.y + (state.unloading && !state.reducedMotion ? .04 * Math.sin(state.time * 7) : 0);
  });
  const baseScale = model.userData.forpostBaseScale as Vector3 | undefined;
  model.scale.y = (baseScale?.y ?? 1) * (state.constructionProgress !== undefined ? .12 + .88 * Math.min(1, Math.max(0, state.constructionProgress)) : 1);
  model.rotation.x = state.sinceHit !== undefined && !state.reducedMotion && state.sinceHit >= 0 && state.sinceHit < .12 ? Math.sin(Math.PI * state.sinceHit / .12) * .035 : 0;
  if (state.destroyProgress !== undefined) {
    const progress = Math.min(1, Math.max(0, state.destroyProgress));
    model.rotation.x = state.reducedMotion ? 0 : progress * .8;
    model.scale.copy(baseScale ?? new Vector3(1, 1, 1)).multiplyScalar(1 - progress * .18);
  }
}

/** Clone disposal must not destroy shared template geometry. */
export function disposeForpostModelMaterials(model: Object3D): void {
  model.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    for (const m of Array.isArray(node.material) ? node.material : [node.material]) m.dispose();
  });
}
