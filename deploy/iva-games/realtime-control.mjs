// Executed inside the reviewed realtime image by the narrowly scoped release handler.
import { readFileSync } from 'node:fs';
const operation = process.argv[2];
if (!['drain', 'resume', 'status'].includes(operation)) throw new Error('Expected drain, resume or status');
const response = await fetch(`http://127.0.0.1:4331/maintenance/realtime/v1/${operation}`, {
  method: 'POST', headers: { 'X-Iva-Maintenance': readFileSync('/data/realtime-maintenance-token', 'utf8') },
  signal: AbortSignal.timeout(25_000),
});
if (!response.ok) throw new Error('Realtime lifecycle request failed');
const value = await response.json();
if (operation === 'drain' && !value.drained) throw new Error('Realtime drain not confirmed');
if (operation === 'resume' && value.drained) throw new Error('Realtime resume not confirmed');
console.log(JSON.stringify({ service: value.service, drained: value.drained, rooms: value.rooms, artifactId: value.artifactId }));
