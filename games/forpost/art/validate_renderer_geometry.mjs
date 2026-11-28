/** Node geometry/raycast checks; this deliberately does not instantiate a browser or WebGL renderer. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'
import { Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three'

const out = resolve('.qa/forpost-art/renderer-geometry.mjs')
await mkdir(resolve('.qa/forpost-art'), { recursive: true })
const entry = resolve('.qa/forpost-art/renderer-entry.mjs')
await writeFile(entry, `export { forpostGroundGeometry, visibleContours } from ${JSON.stringify(resolve('games/forpost/src/client/scene.ts'))}; export { getMap } from ${JSON.stringify(resolve('games/forpost/src/core/maps.ts'))}`)
const bundle = await rolldown({ input: entry, platform: 'node', external: id => id === 'three' || id.startsWith('three/'), transform: { define: { 'import.meta.env.BASE_URL': '"/forpost/"' } } })
await bundle.write({ file: out, format: 'esm' }); await bundle.close()
const { forpostGroundGeometry, visibleContours, getMap } = await import(pathToFileURL(out).href)
const checks = []
function check(name, fn) { fn(); checks.push(name) }
for (const id of ['FP01', 'FP02', 'FP03']) {
  const map = getMap(id), geometry = forpostGroundGeometry(map), mesh = new Mesh(geometry, new MeshBasicMaterial()), ray = new Raycaster()
  check(`${id}: ground remains upward-facing and intersectable at the base`, () => { ray.set(new Vector3(map.bases.L.x, 3, map.bases.L.z), new Vector3(0, -1, 0)); assert.equal(ray.intersectObject(mesh).length > 0, true) })
  check(`${id}: lowered water is not covered by the opaque ground`, () => { for (const water of map.water) { ray.set(new Vector3((water.x1 + water.x2) / 2, 3, (water.z1 + water.z2) / 2), new Vector3(0, -1, 0)); assert.equal(ray.intersectObject(mesh).length, 0) } })
  check(`${id}: triangulated surface area excludes precisely the normative water rectangles`, () => {
    const position = geometry.getAttribute('position'), index = geometry.getIndex(); let area = 0
    for (let i = 0; i < index.count; i += 3) { const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2); area += Math.abs((position.getX(b) - position.getX(a)) * (position.getZ(c) - position.getZ(a)) - (position.getZ(b) - position.getZ(a)) * (position.getX(c) - position.getX(a))) / 2 }
    const expected = map.width * map.height - map.water.reduce((sum, water) => sum + (water.x2 - water.x1) * (water.z2 - water.z1), 0); assert(Math.abs(area - expected) < .001)
  })
  geometry.dispose(); mesh.material.dispose()
}
const map = getMap('FP01')
const makeView = (x, z) => ({ yourTeam: 'A', teams: { A: { side: 'L' }, B: { side: 'R' } }, units: [{ id: 'probe', team: 'A', kind: 'fighter', x, z }], transports: [], buildings: [], smokes: [], walls: map.walls.map(wall => ({ ...wall, hp: wall.destructible ? 300 : -1 })) })
check('permanent hp=-1 wall still truncates the visible contour', () => { const contour = visibleContours(makeView(18, 24), map)[1]; assert.equal(contour[0].x, 19); assert.equal(contour[0].z, 24) })
check('destructible wall truncates sight until its confirmed destruction', () => { const view = makeView(22, 18.5); assert.equal(visibleContours(view, map)[1][0].x, 23); for (const wall of view.walls) if (wall.destructible) wall.hp = 0; assert(visibleContours(view, map)[1][0].x > 23) })
console.log(JSON.stringify({ kind: 'renderer-geometry-check-without-browser', count: checks.length, checks }, null, 2))
