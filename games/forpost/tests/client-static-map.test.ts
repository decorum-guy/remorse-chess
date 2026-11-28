import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { getMap } from '../src/core/maps'
import { forpostStaticMapLayers } from '../src/client/scene'

/** Original per-object transforms are the reference; no GPU/raster claim. */
function compareMerged(actual: THREE.Mesh, original: THREE.Mesh[]): void {
  const geometry = actual.geometry, position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv')
  const index = geometry.getIndex()!, actualMaterial = actual.material as THREE.MeshStandardMaterial
  let vertexOffset = 0, indexOffset = 0, maxPositionError = 0, maxNormalError = 0
  for (const reference of original) {
    reference.updateMatrix()
    const oldPosition = reference.geometry.getAttribute('position'), oldNormal = reference.geometry.getAttribute('normal'), oldUv = reference.geometry.getAttribute('uv'), oldIndex = reference.geometry.getIndex()!
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(reference.matrix)
    for (let i = 0; i < oldPosition.count; i++) {
      const point = new THREE.Vector3().fromBufferAttribute(oldPosition, i).applyMatrix4(reference.matrix)
      const direction = new THREE.Vector3().fromBufferAttribute(oldNormal, i).applyNormalMatrix(normalMatrix)
      maxPositionError = Math.max(maxPositionError, point.distanceTo(new THREE.Vector3().fromBufferAttribute(position, vertexOffset + i)))
      maxNormalError = Math.max(maxNormalError, direction.distanceTo(new THREE.Vector3().fromBufferAttribute(normal, vertexOffset + i)))
      expect([uv.getX(vertexOffset + i), uv.getY(vertexOffset + i)]).toEqual([oldUv.getX(i), oldUv.getY(i)])
    }
    for (let i = 0; i < oldIndex.count; i++) expect(index.getX(indexOffset + i)).toBe(oldIndex.getX(i) + vertexOffset)
    const oldMaterial = reference.material as THREE.MeshStandardMaterial
    expect(actualMaterial.color.equals(oldMaterial.color)).toBe(true)
    for (const key of ['roughness', 'metalness', 'transparent', 'opacity', 'side', 'depthWrite', 'depthTest'] as const) expect(actualMaterial[key]).toBe(oldMaterial[key])
    expect(actual.receiveShadow).toBe(reference.receiveShadow); expect(actual.castShadow).toBe(reference.castShadow)
    vertexOffset += oldPosition.count; indexOffset += oldIndex.count
    reference.geometry.dispose(); oldMaterial.dispose()
  }
  expect(position.count).toBe(vertexOffset); expect(index.count).toBe(indexOffset)
  // Baking a world matrix into Float32 attributes adds only Float32 rounding.
  expect(maxPositionError).toBeLessThan(0.00001); expect(maxNormalError).toBeLessThan(0.000001)
}

describe('static terrain batching preserves the original geometry and appearance settings', () => {
  it.each(['FP01', 'FP02', 'FP03'] as const)('%s preserves every road triangle, kerb face and pad edge', mapId => {
    const map = getMap(mapId), layers = forpostStaticMapLayers(map), oldRoads: THREE.Mesh[] = [], oldKerbs: THREE.Mesh[] = []
    for (const side of ['L', 'R'] as const) for (const route of ['N', 'S'] as const) {
      const path = map.routes[side][route]
      for (let i = 1; i < path.length; i++) {
        const p = path[i - 1], q = path[i]
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(Math.hypot(q.x - p.x, q.z - p.z), 3), new THREE.MeshStandardMaterial({ color: '#4f615c', roughness: .96 }))
        mesh.rotation.x = -Math.PI / 2; mesh.rotation.z = -Math.atan2(q.z - p.z, q.x - p.x); mesh.position.set((p.x + q.x) / 2, .018, (p.z + q.z) / 2); mesh.receiveShadow = true
        oldRoads.push(mesh)
      }
    }
    for (const r of [{ x1: 0, z1: 0, x2: map.width, z2: .5 }, { x1: 0, z1: map.height - .5, x2: map.width, z2: map.height }, { x1: 0, z1: .5, x2: .5, z2: map.height - .5 }, { x1: map.width - .5, z1: .5, x2: map.width, z2: map.height - .5 }]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(r.x2 - r.x1, .4, r.z2 - r.z1), new THREE.MeshStandardMaterial({ color: '#bfc9bc', roughness: .85 }))
      mesh.position.set((r.x1 + r.x2) / 2, .2, (r.z1 + r.z2) / 2); mesh.receiveShadow = true; oldKerbs.push(mesh)
    }
    compareMerged(layers.roads, oldRoads); compareMerged(layers.kerbs, oldKerbs)
    const positions = layers.pads.geometry.getAttribute('position'), material = layers.pads.material as THREE.LineBasicMaterial
    expect(positions.count).toBe(map.pads.length * 8)
    for (const [i, { rect: r }] of map.pads.entries()) {
      const vertices = [[r.x1, r.z1], [r.x2, r.z1], [r.x2, r.z2], [r.x1, r.z2]]
      for (let side = 0; side < 4; side++) for (let end = 0; end < 2; end++) {
        const point = vertices[(side + end) % 4], index = i * 8 + side * 2 + end
        expect(positions.getX(index)).toBeCloseTo(point[0], 5); expect(positions.getY(index)).toBeCloseTo(.04, 6); expect(positions.getZ(index)).toBeCloseTo(point[1], 5)
      }
    }
    expect(material.color.equals(new THREE.Color('#d7d1b4'))).toBe(true)
    expect([material.transparent, material.opacity, material.depthWrite, material.depthTest]).toEqual([true, .75, false, true])
    expect(layers.pads.isLineSegments).toBe(true)
    for (const layer of Object.values(layers)) { layer.geometry.dispose(); (layer.material as THREE.Material).dispose() }
  })
})
