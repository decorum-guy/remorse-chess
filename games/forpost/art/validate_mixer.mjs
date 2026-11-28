/** Control/routing checks with a mock WebAudio graph. This does not decode or audition sound. */
import assert from 'node:assert/strict'
import { ForpostAudio } from '../src/art/audio.ts'

const documentMock = new EventTarget(); documentMock.hidden = false; globalThis.document = documentMock
const nodes = []
class Node {
  constructor(kind) { this.kind = kind; this.gain = { value: 0 }; this.pan = { value: 0 }; this.frequency = { value: 0 }; nodes.push(this) }
  connect(other) { this.output = other }
  disconnect() { this.disconnected = true }
  start() { this.started = true }
  stop() { this.stopped = true; this.onended?.() }
}
class Context {
  state = 'running'; destination = new Node('destination')
  createGain() { return new Node('gain') }
  createBufferSource() { return new Node('source') }
  createBiquadFilter() { return new Node('filter') }
  createStereoPanner() { return new Node('pan') }
  async decodeAudioData() { return { mockedBuffer: true } }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
}
globalThis.AudioContext = Context
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })
const mixer = new ForpostAudio('/forpost/'), checks = []
function check(name, fn) { fn(); checks.push(name) }
check('silence before user unlock', () => assert.equal(mixer.play('carbine'), false))
await mixer.unlock()
check('east source pans right; west left; north remains centered', () => {
  mixer.play('carbine', { sector: 0 }); assert.equal(nodes.filter(node => node.kind === 'pan').at(-1).pan.value, 1)
  mixer.play('carbine', { sector: 4 }); assert.equal(nodes.filter(node => node.kind === 'pan').at(-1).pan.value, -1)
  mixer.play('carbine', { sector: 6 }); assert.equal(Math.abs(nodes.filter(node => node.kind === 'pan').at(-1).pan.value), 0)
})
check('far occluded sound has attenuated gain and low-pass routing', () => {
  mixer.play('carbine', { proximity: 'far', occluded: true }); assert.equal(nodes.filter(node => node.kind === 'filter').at(-1).frequency.value, 1400)
  assert.equal(nodes.filter(node => node.kind === 'gain').at(-1).gain.value, .38)
})
mixer.clear()
check('interface voices never exceed two', () => { for (let i = 0; i < 8; i++) mixer.play('order'); assert.equal(mixer.activeVoices, 2) })
mixer.clear()
check('combat voices never exceed twelve', () => { for (let i = 0; i < 20; i++) mixer.play('carbine'); assert.equal(mixer.activeVoices, 12) })
check('critical outcome displaces a normal combat voice', () => { assert.equal(mixer.play('operation-end'), true); assert.equal(mixer.activeVoices, 12) })
mixer.clear()
check('normal gunfire cannot displace critical outcomes', () => { for (let i = 0; i < 12; i++) mixer.play('operation-end'); assert.equal(mixer.play('carbine'), false); assert.equal(mixer.activeVoices, 12) })
check('mute immediately clears active voices and refuses new ones', () => { mixer.configure({ muted: true }); assert.equal(mixer.activeVoices, 0); assert.equal(mixer.play('carbine'), false); mixer.configure({ muted: false }) })
check('hidden tab stops old voices and suppresses new playback', () => { mixer.play('carbine'); documentMock.hidden = true; documentMock.dispatchEvent(new Event('visibilitychange')); assert.equal(mixer.activeVoices, 0); assert.equal(mixer.play('carbine'), false); documentMock.hidden = false })
await mixer.dispose()
check('disposed context cannot start playback', () => assert.equal(mixer.play('carbine'), false))
console.log(JSON.stringify({ kind: 'mixer-control-check-with-mock-WebAudio', notAnAudition: true, count: checks.length, checks }, null, 2))
