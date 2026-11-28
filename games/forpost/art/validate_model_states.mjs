/** Run with node --experimental-strip-types. This is a model-state check, not a browser test. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { Box3, Color, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import { cloneForpostModel, applyForpostModelState, animateForpostModel } from '../src/art/models.ts'

const loader = new GLTFLoader()
const root = new URL('../public/assets/forpost/models/', import.meta.url)
async function load(name) {
  const bytes = await readFile(fileURLToPath(new URL(`${name}.glb`, root)))
  return (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene
}
const checks = []
function check(name, fn) { fn(); checks.push(name) }
const standard = await load('turret'), low = await load('turret-low'), fighterTemplate = await load('fighter-carbine')
const a = cloneForpostModel(standard, { team: 'A', powered: true })
const b = cloneForpostModel(standard, { team: 'B', powered: true })
const listMaterials = model => { const materials = []; model.traverse(node => { if (node instanceof Mesh) for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material instanceof MeshStandardMaterial) materials.push(material) }); return materials }
const materialsA = listMaterials(a), materialsB = listMaterials(b)
check('separate entity materials', () => assert(materialsA.every(material => !materialsB.includes(material))))
check('actual turret pivot is unique and aim is local', () => {
  const pivots = []; a.traverse(node => { if (node.name === 'turret') pivots.push(node) }); assert.equal(pivots.length, 1)
  animateForpostModel(a, { time: 1, turretYaw: 1.25 }); assert.equal(pivots[0].rotation.y, 1.25); assert.equal(a.rotation.y, 0)
})
check('team shape groups are mutually exclusive', () => {
  assert.equal(a.getObjectByName('Team_A_Insignia').visible, true); assert.equal(a.getObjectByName('Team_B_Insignia').visible, false)
  assert.equal(b.getObjectByName('Team_A_Insignia').visible, false); assert.equal(b.getObjectByName('Team_B_Insignia').visible, true)
})
check('team material color comes from current team', () => {
  const teamMaterial = materialsB.find(material => material.name.startsWith('FP_Team')); assert(teamMaterial.color.equals(new Color('#ffb25b')))
})
check('neutral public presentation has no invented team badge', () => {
  const neutral = cloneForpostModel(standard, { powered: false }); assert.equal(neutral.getObjectByName('Team_A_Insignia').visible, false); assert.equal(neutral.getObjectByName('Team_B_Insignia').visible, false)
})
check('memory presentation freezes opacity and lighting; restoration has original colors', () => {
  const before = materialsA.map(material => material.color.clone())
  applyForpostModelState(a, { team: 'A', powered: false, ghost: true })
  assert(materialsA.every(material => material.opacity === .32 && material.depthWrite === false))
  assert(materialsA.filter(material => material.name.startsWith('FP_Signal')).every(material => material.emissiveIntensity === 0))
  applyForpostModelState(a, { team: 'A', powered: true }); assert(materialsA.every((material, i) => material.opacity === 1 && material.depthWrite && material.color.equals(before[i])))
})
check('suppression color restores on the next normal state', () => {
  const signal = materialsA.find(material => material.name.startsWith('FP_Signal')), color = signal.emissive.clone()
  animateForpostModel(a, { time: 1, suppressed: true }); assert(signal.emissive.equals(new Color('#f06b66')))
  animateForpostModel(a, { time: 2, suppressed: false }); assert(signal.emissive.equals(color))
})
check('construction and confirmed hit presentation reset', () => {
  animateForpostModel(a, { time: 1, constructionProgress: .5, sinceHit: .06 }); assert.equal(a.scale.y, .56); assert(a.rotation.x > 0)
  animateForpostModel(a, { time: 2 }); assert.equal(a.scale.y, 1); assert.equal(a.rotation.x, 0)
})
check('reduced motion preserves orientation without body movement', () => {
  const fighter = cloneForpostModel(fighterTemplate, { team: 'A' })
  animateForpostModel(fighter, { time: 2.1, moving: true, reducedMotion: true, sinceShot: .07, sinceHit: .06 }); assert.equal(fighter.getObjectByName('leg_left').rotation.x, 0); assert.equal(fighter.rotation.x, 0)
})
check('low profile uses fewer mesh primitives and retains aim socket', () => {
  let fullCount = 0, lowCount = 0; standard.traverse(node => { if (node instanceof Mesh) fullCount++ }); low.traverse(node => { if (node instanceof Mesh) lowCount++ }); assert(lowCount < fullCount); assert(low.getObjectByName('turret')); assert(low.getObjectByName('socket_muzzle'))
})
for (const [id, expected] of [['wall', [1, 1.2, 1]], ['wall-destructible', [1, 1.2, 1]]]) {
  const model = await load(id), size = new Box3().setFromObject(model).getSize(new Vector3())
  check(`${id} nominal wall scale matches stage contract (up to 2 mm marking plate overhang)`, () => { assert(Math.abs(size.x - expected[0]) < .001); assert(Math.abs(size.y - expected[1]) < .001); assert(Math.abs(size.z - expected[2]) < .002) })
}
console.log(JSON.stringify({ kind: 'model-state-check', count: checks.length, checks }, null, 2))
