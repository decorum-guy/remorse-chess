import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const game = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(game, 'assets-manifest.json'), 'utf8'));
let models = 0; let audio = 0; let bytes = 0;
for (const item of manifest.assets) {
  const file = path.join(game, item.path); const data = await readFile(file); bytes += data.length;
  if (data.length !== item.bytes || createHash('sha256').update(data).digest('hex') !== item.sha256) throw new Error(`${item.id}: manifest mismatch`);
  if (!item.author || !item.license || !item.source || !item.licenseUrl) throw new Error(`${item.id}: incomplete provenance`);
  if (file.endsWith('.glb')) {
    models++;
    if (data.readUInt32LE(0) !== 0x46546c67 || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) throw new Error(`${item.id}: invalid GLB header`);
    const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString('utf8').trim());
    for (const image of json.images ?? []) if (image.uri) await readFile(path.resolve(path.dirname(file), image.uri));
    for (const accessor of json.accessors) if (accessor.count <= 0) throw new Error(`${item.id}: empty accessor`);
    if (item.id === 'models/chassis' && json.nodes.filter(node => node.extras?.connector).length < 7) throw new Error('Missing chassis sockets');
    if (item.id === 'models/chassis' && !json.materials.some(material => material.name === 'test-bench-chassis-paint')) throw new Error('Missing independently tintable chassis paint');
    if (item.id.startsWith('models/axle-') && !json.nodes.some(node => node.name === 'wheel-spin')) throw new Error(`${item.id}: missing wheel articulation`);
  }
  if (file.endsWith('.wav')) {
    audio++;
    if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${item.id}: invalid WAV header`);
    if (data.readUInt16LE(22) !== 1 || data.readUInt16LE(34) !== 16) throw new Error(`${item.id}: expected mono PCM16`);
    let peak = 0; let square = 0; for (let i = 44; i < data.length; i += 2) { const sample = data.readInt16LE(i); peak = Math.max(peak, Math.abs(sample)); square += sample * sample; }
    if (peak >= 32767 || square === 0) throw new Error(`${item.id}: clipped or silent audio`);
  }
}
console.log(JSON.stringify({ files: manifest.assets.length, models, audio, bytes, hashes: 'verified', sourceAndLicenseFields: 'present', signalCheck: 'non-silent, no PCM clipping', listening: 'not tested by this script' }, null, 2));
