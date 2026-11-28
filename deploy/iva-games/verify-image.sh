#!/usr/bin/env bash
# Isolated runtime and persistence smoke check for the exact candidate image.
set -euo pipefail
umask 077
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$IMAGE_KIND" == realtime ]]; then
  exec "$script_dir/verify-realtime-image.sh"
fi
read -r district_rules district_content < <(
  cd "$script_dir/../.."
  node --experimental-strip-types --input-type=module -e 'import { expectedDistrictProfile as profile } from "./scripts/check-live-catalogue.mjs"; console.log(profile.rulesVersion, profile.contentVersion);'
)
fixture="$(mktemp)"
cleanup() {
  local result=$?
  if [[ "$result" != 0 ]]; then docker logs --tail 150 "$SMOKE_CONTAINER" >&2 || true; fi
  docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$SMOKE_VOLUME" >/dev/null 2>&1 || true
  rm -f -- "$fixture"
}
trap cleanup EXIT

docker volume create "$SMOKE_VOLUME" >/dev/null

start_runtime() {
  local args=(
    --detach --name "$SMOKE_CONTAINER" --init --network none
    --read-only --tmpfs /tmp
    --mount "type=volume,src=$SMOKE_VOLUME,dst=/data"
    --health-interval 2s --health-start-period 5s --health-retries 10
    --env NODE_ENV=production
  )
  if [[ "$IMAGE_KIND" == chess ]]; then
    args+=(--env PUBLIC_ORIGIN=https://chess.iva-games.pro)
    local database_vars
    database_vars="$(python3 - "$script_dir/../../packages/game-registry/games.json" <<'PYENV'
import json, sys
for game in json.load(open(sys.argv[1]))['games']:
    database = game.get('chess', {}).get('database')
    if database:
        print(database['environment'] + '=/data/' + database['file'])
PYENV
    )"
    if [[ -n "$database_vars" ]]; then
      while IFS= read -r database_env; do args+=(--env "$database_env"); done <<< "$database_vars"
    fi
  else
    # Loopback only, without registration delivery channels or recipients.
    args+=(
      --env PORTAL_ORIGIN=https://iva-games.pro
      --env MAIL_MODE=disabled
      --env TELEGRAM_AUTH_ENABLED=false
      --env TELEGRAM_ENABLED=false
      # Existing hosts may retain the retired gate; it must not select old rules.
      --env DISTRICT_TERRITORIAL_ENABLED=false
    )
  fi
  docker run "${args[@]}" "$IMAGE_TAG" >/dev/null
  test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$SMOKE_CONTAINER")" = none
}

wait_healthy() {
  local state
  for attempt in {1..30}; do
    state="$(docker inspect --format '{{.State.Status}}/{{.State.Health.Status}}' "$SMOKE_CONTAINER")"
    if [[ "$state" == running/healthy ]]; then return 0; fi
    if [[ "$state" == exited/* || "$state" == dead/* || "$state" == */unhealthy ]]; then
      printf 'Runtime failed health check: %s\n' "$state" >&2
      return 1
    fi
    sleep 2
  done
  printf 'Runtime did not become healthy within 60 seconds.\n' >&2
  return 1
}

# Passed over stdin to Node in /app so imports resolve to runtime deps.
cat > "$fixture" <<'NODE'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const [kind, phase, districtRules, districtContent] = process.argv.slice(2);
assert.ok(['chess', 'platform'].includes(kind));
assert.ok(['initial', 'restored'].includes(phase));
assert.equal(process.env.NODE_ENV, 'production');
assert.notEqual(process.getuid(), 0, 'Application must run as a non-root user');
const base = kind === 'chess' ? 'http://127.0.0.1:4173' : 'http://127.0.0.1:4310';
const registry = JSON.parse(readFileSync('/app/game-registry.json', 'utf8'));
const chess = registry.games.filter(game => game.chess);
const marker = '/data/ci-persistence.json';
const persisted = phase === 'restored' ? JSON.parse(readFileSync(marker, 'utf8')) : null;
let colossusRoom = null;
const get = async (path, options = {}, expectedStatus = 200) => {
  const response = await fetch(new URL(path, base), {
    ...options, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  assert.equal(response.status, expectedStatus, `${path}: expected HTTP ${expectedStatus}`);
  return response;
};

const healthPaths = kind === 'chess'
  ? chess.filter(game => game.chess.health).map(game => game.chess.health.path)
  : ['/health/live', '/health/ready'];
for (const path of healthPaths) {
  const response = await get(path);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const health = await response.json();
  assert.equal(health.ok, true);
  if (kind === 'platform') assert.equal(health.service, 'iva-platform');
  else {
    const expected = chess.find(game => game.chess.health?.path === path).chess.health;
    assert.equal(health.protocol, expected.protocol);
    assert.equal(health.rulesVersion, expected.rulesVersion);
  }
}

for (const path of kind === 'chess' ? ['/', ...chess.map(game => game.chess.route)] : ['/']) {
  const response = await get(path);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.ok(html.includes('id="root"'), `${path}: missing application root`);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
  assert.ok(assets.some(asset => asset.endsWith('.js')), `${path}: missing JavaScript bundle`);
  assert.ok(assets.some(asset => asset.endsWith('.css')), `${path}: missing stylesheet`);
  for (const asset of assets) {
    const target = new URL(asset, new URL(path, base));
    assert.equal(target.origin, base, 'Static assets must stay on the application origin');
    const resource = await get(target.pathname);
    const mime = resource.headers.get('content-type') ?? '';
    assert.match(mime, asset.endsWith('.js') ? /javascript/ : /text\/css/);
    assert.ok((await resource.arrayBuffer()).byteLength > 100, `${asset}: empty resource`);
  }
}

if (kind === 'platform') {
  assert.equal(process.env.MAIL_MODE, 'disabled');
  assert.equal(process.env.TELEGRAM_AUTH_ENABLED, 'false');
  assert.equal(process.env.TELEGRAM_ENABLED, 'false');
  const catalogue = await (await get('/api/platform/v1/games')).json();
  assert.ok(catalogue.games.some(game => game.gameId === 'platform-lab' && game.status === 'available'));
  assert.ok(catalogue.games.some(game => game.gameId === 'district' && game.status === 'available' && game.supportsBots && game.maxPlayers === 4));
  for (const registered of chess) assert.ok(catalogue.games.some(game => game.gameId === registered.gameId && game.collectionId === 'chess'), `Missing registered game: ${registered.gameId}`);
  const district = catalogue.games.find(game => game.gameId === 'district');
  assert.equal(district.rulesVersion, districtRules, 'The production image must serve the current District rules despite a stale false flag');
  assert.equal(district.contentVersion, districtContent);
  if (phase === 'initial') {
    const response = await get('/api/platform/v1/session');
    assert.match(response.headers.get('set-cookie') ?? '', /__Host-iva_session=/);
    assert.match(response.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.match(response.headers.get('set-cookie') ?? '', /Secure/);
    const session = await response.json();
    assert.equal(session.user, null);
    assert.deepEqual(session.auth, { email: false, telegram: false });
    assert.equal(typeof session.csrfToken, 'string');
    assert.ok(session.csrfToken.length > 20);
  }
} else if (phase === 'initial') {
  const guests = {};
  for (const entry of chess.filter(game => game.chess.health)) {
    const path = entry.chess.health.path.replace(/health$/, 'guest');
    const protocol = entry.chess.health.protocol;
    const cookieName = entry.gameId + '_guest';
    const response = await get(path, {
      method: 'POST', body: '{}',
      headers: { Origin: 'https://chess.iva-games.pro', 'Content-Type': 'application/json' },
    });
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.ok(cookie.startsWith(cookieName + '='));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.equal((await response.json()).protocol, protocol);
    guests[path] = cookie.split(';')[0];
  }
  const post = (path, data, cookie, status = 200) => get(path, { method: 'POST', body: JSON.stringify(data),
    headers: { Origin: 'https://chess.iva-games.pro', 'Content-Type': 'application/json', Cookie: cookie } }, status);
  const cookieA = guests['/api/colossus/guest'];
  const second = await post('/api/colossus/guest', {}, '');
  const cookieB = second.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookieA, cookieB, 'Cooperative players require independent guest sessions');
  const created = await (await post('/api/colossus/rooms', { protocol: 'colossus-online-v1', requestId: randomUUID(),
    name: 'CI Ally A', options: {} }, cookieA, 201)).json();
  await post(`/api/colossus/rooms/${created.snapshot.id}/join`, { protocol: 'colossus-online-v1', name: 'CI Ally B', invite: created.invite }, cookieB);
  const current = (await (await get(`/api/colossus/rooms/${created.snapshot.id}`, { headers: { Cookie: cookieA } })).json()).snapshot;
  const king = current.state.units.find(unit => unit.type === 'K');
  const command = { protocol: 'colossus-online-v1', commandId: randomUUID(), expectedRevision: current.revision,
    command: { type: 'action', action: { type: 'guard', unitId: king.id } } };
  const accepted = await (await post(`/api/colossus/rooms/${created.snapshot.id}/commands`, command, cookieA)).json();
  assert.equal(accepted.snapshot.state.commands, 2);
  assert.equal(accepted.snapshot.state.secret, null);
  colossusRoom = { id: created.snapshot.id, cookieA, command, ack: accepted.ack, state: accepted.snapshot.state };
} else {
  assert.ok(persisted.colossus, 'Missing persisted cooperative room fixture');
  const saved = persisted.colossus;
  const current = (await (await get(`/api/colossus/rooms/${saved.id}`, { headers: { Cookie: saved.cookieA } })).json()).snapshot;
  assert.deepEqual(current.state, saved.state, 'Cooperative state changed after container replacement');
  assert.equal(current.paused, true, 'A restarted server must await client reconnection');
  const replay = await (await get(`/api/colossus/rooms/${saved.id}/commands`, { method: 'POST', body: JSON.stringify(saved.command),
    headers: { Origin: 'https://chess.iva-games.pro', 'Content-Type': 'application/json', Cookie: saved.cookieA } })).json();
  assert.deepEqual(replay.ack, saved.ack, 'The same command must retain its exact durable receipt');
  assert.deepEqual(replay.snapshot.state, saved.state, 'Retry after restart must not spend another command');
}

const databases = kind === 'chess'
  ? chess.filter(game => game.chess.database).map(game => [game.chess.database.file, ['guests', 'rooms', 'commands'], 'guests'])
  : [
      ['platform.sqlite', ['players', 'web_sessions', 'rooms', 'invitations'], 'web_sessions'],
      ['platform-lab.sqlite', ['matches', 'action_receipts', 'district_schema', 'district_matches', 'district_action_receipts'], 'matches'],
    ];
const counts = {};
for (const [file, expectedTables, countTable] of databases) {
  const path = `/data/${file}`;
  accessSync(path, constants.R_OK | constants.W_OK);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    for (const table of expectedTables) assert.ok(tables.has(table), `${file}: missing ${table}`);
    counts[file] = db.prepare(`SELECT count(*) AS count FROM ${countTable}`).get().count;
    if (countTable !== 'matches') assert.ok(counts[file] > 0, `${file}: API session was not persisted`);
    if (file === 'colossus.sqlite') {
      assert.equal(db.pragma('application_id', { simple: true }), 0x434f4c53);
      for (const table of ['rooms', 'commands']) {
        counts[file + '/' + table] = db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
        assert.ok(counts[file + '/' + table] > 0, `Colossus ${table} was not persisted`);
      }
    }
  } finally { db.close(); }
}
if (phase === 'initial') writeFileSync(marker, JSON.stringify({ kind, counts, ...(colossusRoom ? { colossus: colossusRoom } : {}) }), { flag: 'wx', mode: 0o600 });
else {
  const before = JSON.parse(readFileSync(marker, 'utf8'));
  assert.equal(before.kind, kind);
  assert.deepEqual(counts, before.counts, 'Application data changed after container replacement');
}
console.log(`${kind}/${phase}: health, HTML, JS/CSS, API sessions and ${databases.length} SQLite databases passed.`);
NODE

start_runtime
wait_healthy
# Exercise the real image entrypoint and SIGTERM path with a stalled TCP client,
# not just an idle process. Its upload must not prolong a release until SIGKILL.
# The root filesystem stays read-only. Write through the running process into
# the existing writable /tmp tmpfs; Docker's archive-copy API rejects this rootfs.
docker exec --interactive "$SMOKE_CONTAINER" sh -c 'cat > /tmp/iva-shutdown-client.mjs' < "$script_dir/shutdown-client.mjs"
docker exec --detach "$SMOKE_CONTAINER" node /tmp/iva-shutdown-client.mjs "$IMAGE_KIND"
client_ready=false
for attempt in {1..30}; do
  if docker exec "$SMOKE_CONTAINER" test -f /tmp/iva-shutdown-client.ready; then client_ready=true; break; fi
  sleep 0.1
done
test "$client_ready" = true
docker exec --interactive "$SMOKE_CONTAINER" node --input-type=module - "$IMAGE_KIND" initial "$district_rules" "$district_content" < "$fixture"
# The client removes this marker on any response, close, error or exit. Check
# again after the API/static/SQLite fixture, immediately before sending SIGTERM.
docker exec "$SMOKE_CONTAINER" test -f /tmp/iva-shutdown-client.ready
docker stop --timeout 15 "$SMOKE_CONTAINER" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$SMOKE_CONTAINER")" = 0
docker rm "$SMOKE_CONTAINER" >/dev/null

# A new container uses the same named volume; no fixture DB is imported.
start_runtime
wait_healthy
docker exec --interactive "$SMOKE_CONTAINER" node --input-type=module - "$IMAGE_KIND" restored "$district_rules" "$district_content" < "$fixture"
docker stop --timeout 60 "$SMOKE_CONTAINER" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$SMOKE_CONTAINER")" = 0
