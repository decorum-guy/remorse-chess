#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
platform="${1:-}"; realtime="${2:-}"; barrier="${3:-}"
[[ "$platform" == /* && "$realtime" == /* && "$barrier" == /* ]]
[[ -d "$platform/data" && -d "$realtime/data" && -f "$barrier" && ! -e "$platform/INCOMPLETE" && ! -e "$realtime/INCOMPLETE" ]]
[[ "$(cat "$platform/service.txt")" == platform && "$(cat "$realtime/service.txt")" == realtime ]]
image="$(cat "$platform/image-id.txt")"
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]]
verifier="iva-release-pair-$$-${RANDOM}"
cleanup() { timeout --foreground --kill-after=1s 5s docker rm --force "$verifier" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
timeout --foreground --kill-after=3s 45s docker run --name "$verifier" --rm --interactive --network none --user 0:0 \
  --mount "type=bind,src=$platform/data,dst=/platform,readonly" \
  --mount "type=bind,src=$realtime/data,dst=/realtime,readonly" \
  --mount "type=bind,src=$barrier,dst=/barrier.json,readonly" \
  --entrypoint node "$image" --input-type=module - /platform /realtime /barrier.json < "$script_dir/release-pair.mjs"
