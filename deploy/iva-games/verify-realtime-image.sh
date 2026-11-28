#!/usr/bin/env bash
# Exact-image acceptance, isolated from every production socket and database.
set -euo pipefail
umask 077
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
keys="$(mktemp -d)"
cleanup() {
  local result=$?
  if [[ "$result" != 0 ]]; then docker logs --tail 150 "$SMOKE_CONTAINER" >&2 || true; fi
  docker rm -f "$SMOKE_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$SMOKE_VOLUME" >/dev/null 2>&1 || true
  rm -rf -- "$keys"
}
trap cleanup EXIT
node --input-type=module - "$keys" <<'KEYS'
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
writeFileSync(`${process.argv[2]}/private.pem`, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(`${process.argv[2]}/public.json`, JSON.stringify({ ci: publicKey.export({ type: 'spki', format: 'pem' }).toString() }), { mode: 0o644 });
// The caller's restrictive umask protects the private key but also masks this
// public file. Only the public key is mounted for the non-root runtime.
chmodSync(`${process.argv[2]}/public.json`, 0o644);
KEYS
docker volume create "$SMOKE_VOLUME" >/dev/null
revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_TAG")"
start_runtime() {
  docker run --detach --name "$SMOKE_CONTAINER" --init --network none --read-only --tmpfs /tmp \
    --mount "type=volume,src=$SMOKE_VOLUME,dst=/data" \
    --mount "type=bind,src=$keys/public.json,dst=/ci-keys/public.json,readonly" \
    --env REALTIME_TRUSTED_KEYS_FILE=/ci-keys/public.json \
    --health-interval 2s --health-start-period 5s --health-retries 10 "$IMAGE_TAG" >/dev/null
  test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$SMOKE_CONTAINER")" = none
  local state
  for attempt in {1..30}; do
    state="$(docker inspect --format '{{.State.Status}}/{{.State.Health.Status}}' "$SMOKE_CONTAINER")"
    if [[ "$state" == running/healthy ]]; then return; fi
    if [[ "$state" != running/starting ]]; then echo "Realtime image failed health: $state" >&2; return 1; fi
    sleep 2
  done
  echo 'Realtime image health exceeded 60 seconds' >&2; return 1
}
for phase in initial restored; do
  start_runtime
  # The disposable signer stays 0600 on the host and in this container's tmpfs.
  # Stdin avoids exposing it in arguments, logs or a broadly readable mount.
  docker exec --interactive "$SMOKE_CONTAINER" sh -c 'umask 077; cat > /tmp/iva-ci-private.pem' < "$keys/private.pem"
  docker exec --interactive "$SMOKE_CONTAINER" node --input-type=module - "$phase" "$revision" < "$script_dir/realtime-image-fixture.mjs"
  docker exec "$SMOKE_CONTAINER" rm /tmp/iva-ci-private.pem
  docker exec --interactive "$SMOKE_CONTAINER" sh -c 'cat > /tmp/iva-shutdown-client.mjs' < "$script_dir/shutdown-client.mjs"
  docker exec --detach "$SMOKE_CONTAINER" node /tmp/iva-shutdown-client.mjs realtime
  ready=false
  for attempt in {1..30}; do
    if docker exec "$SMOKE_CONTAINER" test -f /tmp/iva-shutdown-client.ready; then ready=true; break; fi
    sleep 0.1
  done
  test "$ready" = true
  docker stop --timeout 15 "$SMOKE_CONTAINER" >/dev/null
  test "$(docker inspect --format '{{.State.ExitCode}}' "$SMOKE_CONTAINER")" = 0
  docker rm "$SMOKE_CONTAINER" >/dev/null
done
