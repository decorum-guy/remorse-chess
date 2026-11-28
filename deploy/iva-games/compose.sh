#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
release_env="${IVA_RELEASE_ENV:-/etc/iva-games/release.env}"
if [[ ! -f "$release_env" ]]; then
  printf 'Missing release configuration: %s\n' "$release_env" >&2
  exit 1
fi
mode="${IVA_REALTIME_ENABLED:-}"
if [[ -z "$mode" ]]; then mode="$(sed -n 's/^IVA_REALTIME_ENABLED=//p' "$release_env")"; fi
files=(--file "$script_dir/compose.yaml")
case "$mode" in
  ''|false) ;;
  true) files+=(--file "$script_dir/compose.realtime.yaml") ;;
  *) echo 'IVA_REALTIME_ENABLED must be true or false' >&2; exit 1 ;;
esac
exec docker compose --project-name iva-games --env-file "$release_env" "${files[@]}" "$@"
