#!/usr/bin/env bash
# Rehydrate a verified backup into a NEW volume; run a non-delivering health check.
set -euo pipefail
umask 077
backup="${1:-}"
volume="${2:-}"
if [[ "$backup" != /* || ! "$volume" =~ ^iva-games-restore-[a-z0-9-]+$ ||
      ! -d "$backup/data" || -e "$backup/INCOMPLETE" ]]; then
  echo 'Usage: restore-check.sh /absolute/verified/backup iva-games-restore-new-name' >&2
  exit 2
fi
if docker volume inspect "$volume" >/dev/null 2>&1; then
  echo 'Restore volume already exists' >&2
  exit 1
fi
service="$(cat "$backup/service.txt")"
image="$(cat "$backup/image-reference.txt")"
[[ "$image" =~ ^ghcr.io/decorum-guy/iva-games-(chess|platform|realtime)@sha256:[0-9a-f]{64}$ ]]
[[ "$image" == *"iva-games-$service@sha256:"* ]]
docker image inspect "$image" >/dev/null
docker volume create "$volume" >/dev/null
docker run --rm --network none --user 0:0 \
  --mount "type=bind,src=$backup/data,dst=/backup,readonly" \
  --mount "type=volume,src=$volume,dst=/data" \
  --entrypoint sh "$image" -ceu 'cp -a /backup/. /data/; chown -R node:node /data'

args=()
case "$service" in
  chess)
    args=(--env PUBLIC_ORIGIN=https://chess.iva-games.pro --env OVERDRIVE_DATABASE_PATH=/data/overdrive.sqlite --env COLOSSUS_DATABASE_PATH=/data/colossus.sqlite)
    ;;
  platform)
    # An isolated, in-container health probe. No route or mail delivery.
    args=(--env PORTAL_ORIGIN=https://iva-games.pro --env MAIL_MODE=smtp
          --env SMTP_HOST=mail.invalid --env SMTP_FROM=restore@example.invalid --env TELEGRAM_ENABLED=false)
    ;;
  realtime)
    args=(--env REALTIME_PUBLIC_ORIGIN=https://iva-games.pro)
    ;;
esac
container="$(docker run -d --init --network none --read-only --tmpfs /tmp \
  --mount "type=volume,src=$volume,dst=/data" --health-interval 2s \
  --health-start-period 5s "${args[@]}" "$image")"
trap 'docker rm -f "$container" >/dev/null' EXIT
for attempt in {1..25}; do
  health="$(docker inspect --format '{{.State.Status}}/{{.State.Health.Status}}' "$container")"
  if [[ "$health" != running/starting ]]; then break; fi
  sleep 2
done
test "$health" = running/healthy
docker exec -i "$container" node --input-type=module - "$service" <<'JS'
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
const registered = existsSync('/app/game-registry.json')
  ? JSON.parse(readFileSync('/app/game-registry.json', 'utf8')).games.filter(game => game.chess?.database).map(game => game.chess.database.file)
  : ['remorse.sqlite', 'overdrive.sqlite'];
const required = process.argv[2] === 'chess' ? registered : process.argv[2] === 'realtime' ? ['realtime.sqlite'] : ['platform.sqlite', 'platform-lab.sqlite'];
// Include every database present in old/new backups, while requiring this image's registered files.
const files = [...new Set([...required, ...readdirSync('/data').filter(name => name.endsWith('.sqlite'))])].map(name => '/data/' + name);
for (const path of files) {
  const db = new Database(path, {readonly: true, fileMustExist: true});
  assert.equal(db.pragma('integrity_check', {simple: true}), 'ok', path);
  assert.deepEqual(db.pragma('foreign_key_check'), [], path);
  db.close();
}
JS
docker stop --timeout 60 "$container" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$container")" = 0
printf 'Restore and isolated health passed for %s in %s\n' "$service" "$volume"
