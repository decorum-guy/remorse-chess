#!/usr/bin/env bash
# Actual isolated container admission and crash-safe SQLite restoration.
set -euo pipefail
umask 077
fixture="$(mktemp)"
preflight_container="${SMOKE_CONTAINER}-preflight"
cleanup() {
  local result=$?
  if [[ "$result" != 0 ]]; then docker logs --tail 100 "$SMOKE_CONTAINER" >&2 || true; fi
  docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$preflight_container" >/dev/null 2>&1 || true
  docker volume rm "$SMOKE_VOLUME" >/dev/null 2>&1 || true
  rm -f -- "$fixture"
}
trap cleanup EXIT
docker volume create "$SMOKE_VOLUME" >/dev/null
preflight() {
  # The verifier uses the real image USER and actual store, without network or
  # write access. Empty-store permission is explicit and only used before start.
  docker run --rm --name "$preflight_container" --network none --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=volume,src=$SMOKE_VOLUME,dst=/data,readonly,volume-nocopy" \
    --entrypoint node "$IMAGE_TAG" /app/dist-realtime/retention-cli.js check-store \
    --database /data/realtime.sqlite "$@"
}
start() {
  docker run --detach --name "$SMOKE_CONTAINER" --init --network none --read-only --tmpfs /tmp \
    --mount "type=volume,src=$SMOKE_VOLUME,dst=/data" --health-interval 2s --health-start-period 5s \
    --env REALTIME_PUBLIC_ORIGIN=https://iva-games.pro "$IMAGE_TAG" >/dev/null
  for attempt in {1..30}; do
    state="$(docker inspect --format '{{.State.Status}}/{{.State.Health.Status}}' "$SMOKE_CONTAINER")"
    if [[ "$state" == running/healthy ]]; then return; fi
    if [[ "$state" == exited/* || "$state" == dead/* || "$state" == */unhealthy ]]; then return 1; fi
    sleep 2
  done
  return 1
}
cat > "$fixture" <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
const origin = 'https://iva-games.pro', base = 'http://127.0.0.1:4331';
const phase = process.argv[2];
assert.notEqual(process.getuid(), 0);
let fixture = phase === 'restored' ? JSON.parse(readFileSync('/data/smoke.json', 'utf8')) : null;
const response = await fetch(base + (fixture ? `/api/realtime/v1/practice/${fixture.matchId}/ticket` : '/api/realtime/v1/practice'), {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(fixture ? { Cookie: fixture.cookie } : {}) },
  body: JSON.stringify(fixture ? {} : { mapId: 'FP02', teamSize: 1, displayName: 'Container QA', botLevel: 'novice' }),
});
assert.equal(response.status, fixture ? 200 : 201);
const admission = await response.json();
if (!fixture) fixture = { matchId: admission.matchId, cookie: response.headers.get('set-cookie').split(';')[0], epoch: 0 };
const ws = new WebSocket('ws://127.0.0.1:4331/ws/realtime/v1', 'iva-realtime-v1', { origin });
const queue = []; ws.on('message', raw => queue.push(JSON.parse(raw.toString())));
await once(ws, 'open'); ws.send(JSON.stringify({ type: 'authenticate', ticket: admission.ticket }));
async function wait(predicate) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { const index = queue.findIndex(predicate); if (index >= 0) return queue.splice(index, 1)[0]; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Realtime container did not return the expected state');
}
const hello = await wait(m => m.type === 'hello');
if (phase === 'restored') assert.ok(hello.epoch > fixture.epoch);
fixture.epoch = hello.epoch;
const full = await wait(m => m.type === 'full'); assert.equal(full.view.matchId, fixture.matchId); assert.equal(full.view.seed, undefined);
const html = await (await fetch(base + '/play/forpost/')).text(); assert.match(html, /<html/);
writeFileSync('/data/smoke.json', JSON.stringify(fixture), { mode: 0o600 });
ws.close(); await once(ws, 'close');
const db = new Database('/data/realtime.sqlite', { readonly: true });
assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
const stored = db.prepare("SELECT DISTINCT json_extract(record_json,'$.manifest') AS manifest FROM rt_matches WHERE expires_at>? OR phase NOT IN ('finished','abandoned')").all(Date.now()).map(row => JSON.parse(row.manifest));
db.close();
const inventoryResponse = await fetch(base + '/api/realtime/v1/compatibility');
assert.equal(inventoryResponse.status, 200);
assert.equal(inventoryResponse.headers.get('cache-control'), 'no-store');
const inventory = await inventoryResponse.json();
const bundle = JSON.parse(readFileSync('/app/retention/bundle.json', 'utf8'));
assert.deepEqual(Object.keys(inventory).sort(), ['buildRevision', 'current', 'format', 'manifests']);
assert.equal(inventory.format, 1); assert.equal(inventory.buildRevision, process.env.IVA_BUILD_SHA);
assert.deepEqual(inventory.current, bundle.current); assert.equal(inventory.manifests.length, 1);
const fields = ['runtime', 'rules', 'content', 'protocol', 'serializer', 'bot', 'map', 'physics', 'prng', 'client'].sort();
for (const manifest of inventory.manifests) assert.deepEqual(Object.keys(manifest).sort(), fields);
assert.deepEqual(inventory.manifests, stored);
assert.ok(!JSON.stringify(inventory).includes(fixture.matchId));
console.log(`Realtime ${phase}: authentic admission, private view, real client HTML, SQLite and sanitized actual-store inventory passed.`);
NODE
preflight --allow-empty-store
start
docker exec -i "$SMOKE_CONTAINER" node --input-type=module - initial < "$fixture"
docker exec "$SMOKE_CONTAINER" node /app/scripts/realtime-control.mjs drain
preflight
docker exec "$SMOKE_CONTAINER" node /app/scripts/realtime-control.mjs resume
docker stop --timeout 60 "$SMOKE_CONTAINER" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$SMOKE_CONTAINER")" = 0
docker rm "$SMOKE_CONTAINER" >/dev/null
start
docker exec -i "$SMOKE_CONTAINER" node --input-type=module - restored < "$fixture"
docker exec "$SMOKE_CONTAINER" node /app/scripts/realtime-control.mjs drain
preflight
docker stop --timeout 60 "$SMOKE_CONTAINER" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$SMOKE_CONTAINER")" = 0
