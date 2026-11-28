#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:-drain}"
[[ "$mode" == drain || "$mode" == cancel ]]
platform="$(timeout --foreground --kill-after=2s 10s "$script_dir/compose.sh" ps --quiet platform)"
[[ -n "$platform" && "$platform" != *$'\n'* ]]
timeout --foreground --kill-after=3s 35s docker exec --interactive "$platform" \
  node --input-type=module - "$mode" < "$script_dir/drain-realtime.mjs"
