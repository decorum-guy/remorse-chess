#!/usr/bin/env bash
# Run once as root after provisioning Docker Engine and Compose on the VPS.
set -euo pipefail
umask 077
if [[ "$EUID" != 0 || $# != 3 ]]; then
  echo 'Usage: install-host.sh IPV4 CADDY_IMAGE_WITH_DIGEST CI_PUBLIC_KEY_FILE' >&2
  exit 2
fi
ipv4="$1"
caddy="$2"
ci_key="$3"
source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
config=/etc/iva-games
runtime=/opt/iva-games/deploy
state=/var/lib/iva-games/activation

test ! -e "$config/release.env"
[[ "$caddy" =~ ^(caddy|docker.io/library/caddy)@sha256:[0-9a-f]{64}$ ]]
python3 - "$ipv4" <<'PY'
import ipaddress
import sys
ipaddress.IPv4Address(sys.argv[1])
PY
ssh-keygen -lf "$ci_key" >/dev/null
docker image inspect "$caddy" >/dev/null

install -d -m 700 "$runtime" "$config" "$state" /srv/iva-games-backups
# The CI wrapper is reachable by the restricted account; only root can write it.
chmod 755 /opt/iva-games "$runtime"
install -m 755 "$source"/{activation.py,backup.sh,ci-deploy,compose.sh,restore-check.sh,drain-realtime.sh,verify-pair.sh,configure-telegram-auth.py} "$runtime/"
install -m 644 "$source"/{drain-realtime.mjs,release-pair.mjs} "$runtime/"
install -m 644 "$source"/{Caddyfile,Caddyfile.realtime,compose.yaml,compose.realtime.yaml} "$runtime/"
install -m 644 "$source"/iva-games-activate.{service,timer} /etc/systemd/system/
install -m 600 "$source/platform.env.example" "$config/platform.env"
sed -e 's@^CHESS_IMAGE=$@CHESS_IMAGE=iva-games-unset:chess@' \
    -e 's@^PLATFORM_IMAGE=$@PLATFORM_IMAGE=iva-games-unset:platform@' \
    -e "s|^CADDY_IMAGE=\$|CADDY_IMAGE=$caddy|" "$source/release.env.example" > "$config/release.env"
printf '{"ipv4":"%s","initial_sha":null}\n' "$ipv4" > "$config/activation.json"

for name in chess-data platform-data caddy-data caddy-config; do
  docker volume create "iva-games-$name" >/dev/null
done
"$runtime/compose.sh" config --quiet
docker run --rm --network none --read-only --tmpfs /data --tmpfs /config --tmpfs /tmp \
  --mount "type=bind,src=$runtime/Caddyfile,dst=/etc/caddy/Caddyfile,readonly" \
  --entrypoint caddy "$caddy" validate --config /etc/caddy/Caddyfile --adapter caddyfile

id iva-deploy >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/iva-deploy --shell /bin/sh iva-deploy
install -d -m 755 /var/lib/iva-deploy /var/lib/iva-deploy/.ssh
printf 'restrict,command="/opt/iva-games/deploy/ci-deploy" %s\n' "$(cat "$ci_key")" \
  > /var/lib/iva-deploy/.ssh/authorized_keys
chmod 644 /var/lib/iva-deploy/.ssh/authorized_keys
visudo -cf "$source/iva-deploy.sudoers"
install -m 440 "$source/iva-deploy.sudoers" /etc/sudoers.d/iva-deploy
systemd-analyze verify /etc/systemd/system/iva-games-activate.{service,timer}
systemctl daemon-reload
systemctl enable --now iva-games-activate.timer
