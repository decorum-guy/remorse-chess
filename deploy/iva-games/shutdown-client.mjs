// CI-only loopback client: a JSON upload which never finishes. No account,
// game action, remote recipient or outbound network is involved.
import { connect } from 'node:net';
import { rmSync, writeFileSync } from 'node:fs';

const kind = process.argv[2];
if (!['chess', 'platform', 'realtime'].includes(kind)) throw new Error('Unknown image kind');
const readyFile = process.env.SHUTDOWN_SMOKE_READY_FILE ?? '/tmp/iva-shutdown-client.ready';
rmSync(readyFile, { force: true });
process.once('exit', () => { rmSync(readyFile, { force: true }); });
const port = Number(process.env.SHUTDOWN_SMOKE_PORT ?? ({ chess: 4173, platform: 4310, realtime: 4320 }[kind]));
const origin = kind === 'chess' ? 'https://chess.iva-games.pro' : 'https://iva-games.pro';
let path = '/api/guest', sessionHeaders = '';
if (kind === 'platform') {
  // An anonymous bootstrap session only. Start this client before the existing
  // persistence fixture records row counts, so the extra session is accounted for.
  const response = await fetch(`http://127.0.0.1:${port}/api/platform/v1/session`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('Could not bootstrap loopback client');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  const { csrfToken } = await response.json();
  if (!cookie || typeof csrfToken !== 'string') throw new Error('Missing loopback session');
  sessionHeaders = `Cookie: ${cookie}\r\nX-CSRF-Token: ${csrfToken}\r\n`;
  path = '/api/platform/v1/auth/register';
}
if (kind === 'realtime') path = '/internal/realtime/v1/drain';
const socket = connect(port, '127.0.0.1');
socket.resume();
const deadline = setTimeout(() => process.exit(1), 40_000);
let readinessTimer;
// A 400/403 response must never count as a held upload. The readiness marker
// remains valid only while this client has received no response and stays open.
socket.on('data', () => process.exit(1));
socket.on('error', () => process.exit(1));
socket.on('close', () => {
  clearTimeout(deadline); clearTimeout(readinessTimer);
  rmSync(readyFile, { force: true });
});
socket.on('connect', () => {
  socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\n${sessionHeaders}Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{`, error => {
    if (error) { process.exit(1); }
    readinessTimer = setTimeout(() => {
      if (socket.destroyed || socket.readyState !== 'open') { process.exit(1); }
      writeFileSync(readyFile, kind);
    }, 300);
  });
});
