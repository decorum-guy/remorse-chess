/** A bounded TCP relay for isolated test servers. Every byte follows the normal
 * HTTP/WS stack; only transit is delayed. Never point this at production. */
import { createServer, connect } from 'node:net';
export async function delayedLoopback(targetPort, delayMs = 60) {
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 1000) throw new Error('Invalid isolated latency fixture');
  const sockets = new Set(); const timers = new Set();
  const server = createServer(client => {
    const upstream = connect({ host: '127.0.0.1', port: targetPort });
    sockets.add(client); sockets.add(upstream);
    client.setNoDelay(true); upstream.setNoDelay(true);
    const pipe = (from, to) => {
      let buffered = 0; let blocked = false;
      const resume = () => { if (buffered < 256 * 1024 && !blocked && !from.destroyed) from.resume(); };
      from.on('data', bytes => {
        buffered += bytes.length;
        if (buffered >= 512 * 1024) from.pause();
        if (buffered > 1024 * 1024) { from.destroy(); to.destroy(); return; }
        const timer = setTimeout(() => {
          timers.delete(timer); buffered -= bytes.length;
          if (!to.destroyed && !to.write(bytes)) { blocked = true; from.pause(); }
          resume();
        }, delayMs);
        timers.add(timer);
      });
      to.on('drain', () => { blocked = false; resume(); });
      from.on('error', () => to.destroy());
      from.on('close', () => { sockets.delete(from); if (!to.destroyed) to.destroy(); });
    };
    pipe(client, upstream); pipe(upstream, client);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    port: server.address().port, delayPerDirectionMs: delayMs,
    async close() { for (const timer of timers) clearTimeout(timer); timers.clear(); for (const socket of sockets) socket.destroy(); sockets.clear(); await new Promise(resolve => server.close(resolve)); },
  };
}
