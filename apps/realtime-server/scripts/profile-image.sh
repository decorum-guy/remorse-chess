#!/usr/bin/env bash
# A profiling-only run of the already-built production image. No deployment.
set -euo pipefail
umask 077
: "${IMAGE_TAG:?Set the already-built realtime image tag or digest}"
: "${FORPOST_QA_OUTPUT_DIRECTORY:?Set an isolated writable directory for raw local QA evidence}"
[[ "$FORPOST_QA_OUTPUT_DIRECTORY" = /* ]]
qa_source="$(git rev-parse --show-toplevel)"
qa_commit="$(git rev-parse HEAD)"
qa_seconds=3600
qa_rooms=4
for argument in "$@"; do
  case "$argument" in
    --seconds=*) qa_seconds="${argument#--seconds=}" ;;
    --rooms=*) qa_rooms="${argument#--rooms=}" ;;
    *) echo '{"stage":"image-profile","code":"INVALID_ARGUMENT"}' >&2; exit 2 ;;
  esac
done
[[ "$qa_seconds" =~ ^[0-9]+$ && "$qa_rooms" =~ ^[0-9]+$ ]]
((qa_seconds >= 30 && qa_seconds <= 7200 && qa_rooms >= 1 && qa_rooms <= 4))
mkdir -p -- "$FORPOST_QA_OUTPUT_DIRECTORY"
qa_output="$(mktemp -d "$FORPOST_QA_OUTPUT_DIRECTORY/profile.XXXXXX")"
# The parent runner temp directory is private. The image remains USER node;
# its 0700/0600 sealed archives must not be opened under a different UID.
chmod 0777 "$qa_output"
qa_trace="$(mktemp "$FORPOST_QA_OUTPUT_DIRECTORY/source.XXXXXX.json")"
node "$qa_source/apps/realtime-server/scripts/source-identity.mjs" --root="$qa_source" --output="$qa_trace"
chmod 0644 "$qa_trace" # Hash inventory only, no credentials or saved worlds.
qa_id="$(docker image inspect "$IMAGE_TAG" --format '{{.Id}}')"
qa_revision="$(docker image inspect "$qa_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
qa_repository="$(docker image inspect "$qa_id" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')"
qa_user="$(docker image inspect "$qa_id" --format '{{.Config.User}}')"
[[ "$qa_id" =~ ^sha256:[0-9a-f]{64}$ && "$qa_revision" = "$qa_commit" && "$qa_repository" = 'https://github.com/decorum-guy/iva-games' && "$qa_user" = 'node' ]]
node --input-type=module - "$qa_trace" "$qa_revision" <<'NODE'
import { readFileSync } from 'node:fs';
const trace = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (trace.dirty || trace.gitCommit !== process.argv[3]) throw new Error('A clean exact image source is required');
NODE
for path in "$qa_source" "$qa_trace" "$qa_output"; do
  if [[ "$path" == *','* || "$path" == *$'\n'* ]]; then exit 2; fi
done
qa_container="forpost-profile-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
cleanup() {
  docker stop --time 45 "$qa_container" >/dev/null 2>&1 || true
  docker rm -f "$qa_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
docker run --rm --name "$qa_container" --init --read-only --network none --no-healthcheck \
  --cpus=2 --memory=2g --memory-swap=2g --pids-limit=128 --cap-drop=ALL \
  --security-opt=no-new-privileges --stop-timeout=45 \
  --tmpfs /tmp:rw,nosuid,size=64m \
  --tmpfs /app/qa:rw,nosuid,size=16m,mode=0700,uid=1000,gid=1000 \
  --mount "type=bind,src=$qa_source,dst=/qa/source,readonly" \
  --mount "type=bind,src=$qa_trace,dst=/qa/source-trace.json,readonly" \
  --mount "type=bind,src=$qa_output,dst=/qa-output" \
  --env NODE_ENV=test --env FORPOST_QA_SOURCE_DIRECTORY=/qa/source \
  --env FORPOST_QA_SOURCE_TRACE=/qa/source-trace.json --env FORPOST_QA_EXPECTED_BUILD_SHA="$qa_revision" \
  --env FORPOST_QA_IMAGE_ID="$qa_id" --env FORPOST_QA_OUTPUT_DIRECTORY=/qa-output \
  --env FORPOST_QA_RUNTIME_ENTRY=/app/dist-realtime/main.js --env FORPOST_QA_CLIENT_DIRECTORY=/app/client \
  --entrypoint node "$qa_id" /qa/source/apps/realtime-server/scripts/image-load-bootstrap.mjs \
  "--seconds=$qa_seconds" "--rooms=$qa_rooms"
