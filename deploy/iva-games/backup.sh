#!/usr/bin/env bash
# Freeze ONE application while copying its entire /data, including SQLite WAL.
# Resume it BEFORE checking a disposable copy. No stop/restart or live WAL copy.
# This also works for an old image whose shutdown handler cannot drain HTTP.
set -euo pipefail
umask 077
# --foreground keeps each bounded CLI in the deployment process group. An outer
# SIGTERM must reach it immediately so Bash can run the thaw trap, not wait for
# an orphaned `timeout` process group to finish its whole copy deadline.

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service="${1:-}"
destination="${2:-}"
if [[ "$service" != chess && "$service" != platform && "$service" != realtime ]] || [[ "$destination" != /* ]] || [[ -e "$destination" ]]; then
  printf 'Usage: backup.sh chess|platform|realtime /absolute/new/backup-directory\n' >&2
  exit 1
fi
container_id="$(timeout --foreground --kill-after=3s 10s "$script_dir/compose.sh" ps --all --quiet "$service")"
if [[ -z "$container_id" || "$container_id" == *$'\n'* ]]; then
  printf 'Expected exactly one existing %s container.\n' "$service" >&2
  exit 1
fi
metadata="$(timeout --foreground --kill-after=3s 10s docker inspect --format '{{.Image}}|{{.State.Running}}|{{.State.Paused}}|{{.Config.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}' "$container_id")"
IFS='|' read -r image_id was_running was_paused image_reference revision <<< "$metadata"
if [[ "$was_paused" != false ]] || [[ "$was_running" != true && "$was_running" != false ]]; then
  printf 'Refusing to change an already paused or unknown %s container.\n' "$service" >&2
  exit 1
fi
thaw_needed=false
verification_container=''
resume_original() {
  local state
  state="$(timeout --foreground --kill-after=1s 3s docker inspect --format '{{.State.Running}} {{.State.Paused}}' "$container_id")" || return 1
  if [[ "$state" == 'true true' ]]; then
    timeout --foreground --kill-after=1s 5s docker unpause "$container_id" >/dev/null || return 1
  elif [[ "$state" != 'true false' ]]; then
    return 1
  fi
  state="$(timeout --foreground --kill-after=1s 3s docker inspect --format '{{.State.Running}} {{.State.Paused}}' "$container_id")" || return 1
  [[ "$state" == 'true false' ]] || return 1
  thaw_needed=false
}
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$thaw_needed" == true ]]; then
    if ! resume_original; then
      printf 'Could not unpause %s; inspect and unpause this original container manually.\n' "$service" >&2
      result=1
    fi
  fi
  if [[ -n "$verification_container" ]]; then
    # Only the disposable verifier may be force-removed, never an application.
    timeout --foreground --kill-after=1s 5s docker rm --force "$verification_container" >/dev/null 2>&1 || true
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -m 700 -- "$destination"
touch "$destination/INCOMPLETE"
printf '%s\n' "$service" > "$destination/service.txt"
printf '%s\n' "$image_id" > "$destination/image-id.txt"
printf '%s\n' "$image_reference" > "$destination/image-reference.txt"
printf '%s\n' "$revision" > "$destination/revision.txt"
if [[ "$was_running" == true ]]; then
  printf 'paused-filesystem-v1\n' > "$destination/backup-method.txt"
else
  printf 'stopped-filesystem-v1\n' > "$destination/backup-method.txt"
fi

if [[ "$was_running" == true ]]; then
  # Set before requesting pause: a lost Docker reply must still trigger cleanup.
  thaw_needed=true
  timeout --foreground --kill-after=3s 10s docker pause "$container_id" >/dev/null
  [[ "$(timeout --foreground --kill-after=1s 3s docker inspect --format '{{.State.Running}} {{.State.Paused}}' "$container_id")" == 'true true' ]]
fi
mkdir -m 700 "$destination/data"
# Bound the service pause. If data no longer fits this window, fail the release;
# do not silently extend user-visible stalls or accept a partial snapshot.
timeout --foreground --kill-after=3s 20s docker cp "$container_id:/data/." "$destination/data/"
if [[ "$thaw_needed" == true ]]; then resume_original; fi

# Open a private disposable copy, leaving the saved directory read-only.
# Use the exact original image so the SQLite binding matches the application.
verification_container="iva-backup-check-${service}-$$-${RANDOM}"
timeout --foreground --kill-after=3s 60s docker run --name "$verification_container" --rm --interactive --network none --user 0:0 \
  --mount "type=bind,src=$destination/data,dst=/backup,readonly" \
  --entrypoint node "$image_id" --input-type=module - "$service" <<'NODE'
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
function archivePaths(root, client) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Invalid archive directory');
  const paths = [];
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Archive symlink is forbidden');
      if (client && path === '.iva-client-manifest.json') continue;
      if (client && entry.name.startsWith('.')) throw new Error('Hidden client archive file');
      if (entry.isDirectory()) visit(`${directory}/${entry.name}`, path + '/');
      else if (entry.isFile()) { if (client || entry.name.endsWith('.js')) paths.push(path); }
      else throw new Error('Invalid archive entry');
    }
  }
  visit(root); return paths.sort();
}
const directory = mkdtempSync('/tmp/iva-backup-check-');
cpSync('/backup', directory, { recursive: true });
const registered = existsSync('/app/game-registry.json')
  ? JSON.parse(readFileSync('/app/game-registry.json', 'utf8')).games.filter(game => game.chess?.database).map(game => game.chess.database.file)
  : ['remorse.sqlite', 'overdrive.sqlite'];
const required = process.argv[2] === 'chess' ? registered : process.argv[2] === 'realtime' ? ['realtime.sqlite'] : ['platform.sqlite', 'platform-lab.sqlite'];
const names = [...new Set([...required, ...readdirSync(directory).filter(name => name.endsWith('.sqlite'))])];
for (const name of names) {
  const database = new Database(`${directory}/${name}`, { fileMustExist: true });
  try {
    const rows = database.pragma('quick_check');
    if (rows.length !== 1 || rows[0].quick_check !== 'ok') throw new Error(`Invalid SQLite backup: ${name}`);
    if (name === 'realtime.sqlite') {
      const manifests = database.prepare('SELECT manifest FROM rt_matches').all().map(row => JSON.parse(row.manifest));
      const artifacts = new Set(manifests.map(manifest => {
        const id = manifest.runtimeArtifactId.match(/:([a-f0-9]{64})$/)?.[1];
        if (!id) throw new Error('Invalid persisted runtime artifact ID');
        return id;
      }));
      for (const id of artifacts) {
        const root = `${directory}/runtime-artifacts/${id}`;
        const manifest = JSON.parse(readFileSync(`${root}/manifest.json`, 'utf8'));
        if (manifest.protocol !== 'iva-worker@1' || manifest.sha256 !== id || !Array.isArray(manifest.files)) throw new Error('Invalid runtime archive');
        const digest = createHash('sha256');
        const paths = manifest.files.map(file => file.path);
        if (!paths.includes('simulation-worker.js') || JSON.stringify(paths) !== JSON.stringify(archivePaths(root, false))) throw new Error('Invalid runtime archive file set');
        for (const file of manifest.files) {
          if (!/^[a-zA-Z0-9_./-]+\.js$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..')) throw new Error('Invalid runtime archive path');
          const bytes = readFileSync(`${root}/${file.path}`);
          if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Corrupt runtime archive file');
          digest.update(file.path).update('\0').update(bytes).update('\0');
        }
        if (digest.digest('hex') !== id) throw new Error('Corrupt runtime archive identity');
      }
      console.log(`${artifacts.size} referenced runtime archives passed SHA256 verification.`);
      const clients = new Set();
      for (const world of manifests) {
        if (world.clientContentHash === undefined && world.clientRoute === undefined) continue;
        const id = world.clientContentHash;
        if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-z][a-z0-9-]{0,63}$/.test(world.gameId) ||
          world.clientRoute !== `/play/${world.gameId}/versions/${id}/`) throw new Error('Invalid persisted client identity');
        const root = `${directory}/client-artifacts/${id}`;
        const manifest = JSON.parse(readFileSync(`${root}/.iva-client-manifest.json`, 'utf8'));
        const meta = { gameId: world.gameId, route: `/play/${world.gameId}/`, rulesVersion: world.rulesVersion, contentVersion: world.contentVersion };
        if (manifest.schema !== 1 || manifest.sha256 !== id || !Number.isFinite(manifest.createdAt) || !Array.isArray(manifest.files) ||
          Object.entries(meta).some(([key, value]) => manifest[key] !== value)) throw new Error('Invalid client archive manifest');
        const paths = archivePaths(root, true);
        if (!paths.includes('index.html') || JSON.stringify(paths) !== JSON.stringify(manifest.files.map(file => file.path))) throw new Error('Invalid client archive file set');
        const digest = createHash('sha256').update(canonical(meta)).update('\0');
        for (const file of manifest.files) {
          const bytes = readFileSync(`${root}/${file.path}`);
          if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Corrupt client archive file');
          digest.update(file.path).update('\0').update(bytes).update('\0');
        }
        if (digest.digest('hex') !== id) throw new Error('Corrupt client archive identity');
        clients.add(id);
      }
      console.log(`${clients.size} referenced browser archives passed SHA256 verification.`);
    }
  } finally { database.close(); }
}
console.log(`${names.length} SQLite databases passed quick_check.`);
NODE
verification_container=''

rm "$destination/INCOMPLETE"
printf 'Verified %s backup: %s\n' "$service" "$destination"
