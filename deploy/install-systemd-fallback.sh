#!/usr/bin/env bash
# Pre-quadlet equivalent of deploy/install-quadlet.sh, for podman < 4.4
# (Debian 12 ships 4.3.1, which has no quadlet generator).
#
# Produces the same topology as quadlet/ — open-assistant network, backend /
# frontend / caddy containers, same volumes, env and ports — as real systemd
# units via `podman generate systemd --new`. Switch to install-quadlet.sh once
# podman is >= 4.4.
#
# Run as root ON THE SERVER:
#     sudo bash ~/oa-deploy/deploy/install-systemd-fallback.sh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/mnt/storage/open-assistant}"
UNIT_DIR="/etc/systemd/system"

[[ $EUID -eq 0 ]] || { echo "ERROR: run as root (sudo bash $0)"; exit 1; }

# netavark shells out to iptables to program NAT/port rules. Debian points the
# `iptables` alternative at the nft backend, but this kernel ships no nf_tables
# module, so nft fails with "Could not fetch rule set generation id" and every
# container start dies. Legacy iptables works here (ip_tables/iptable_nat exist).
ensure_iptables_backend() {
  if iptables -L -n >/dev/null 2>&1; then return 0; fi
  echo "==> iptables (nft backend) unusable; switching to legacy"
  modprobe ip_tables   2>/dev/null || true
  modprobe iptable_nat 2>/dev/null || true
  [[ -x /usr/sbin/iptables-legacy ]] \
    && update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null
  [[ -x /usr/sbin/ip6tables-legacy ]] \
    && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null || true
  iptables -L -n >/dev/null 2>&1 \
    || { echo "ERROR: iptables still unusable — container networking cannot start"; exit 1; }
  echo "    ok: using $(readlink -f "$(command -v iptables)")"
}
ensure_iptables_backend

echo "==> Staging application into $APP_DIR"
install -d -m 755 "$APP_DIR"
install -d -m 755 "$APP_DIR/data/frontend" "$APP_DIR/data/backend"
install -d -m 755 "$APP_DIR/data/caddy/data" "$APP_DIR/data/caddy/config"

rsync -a --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'dist' --exclude '/data' \
  "$SRC_DIR"/ "$APP_DIR"/

for f in .env frontend.env; do
  [[ -f "$APP_DIR/$f" ]] || { echo "ERROR: missing $APP_DIR/$f"; exit 1; }
  chmod 600 "$APP_DIR/$f"
done
grep -q '^ALLOWED_HOSTS=' "$APP_DIR/.env" \
  || { echo "ERROR: .env must set ALLOWED_HOSTS (WebAuthn RP id)"; exit 1; }

echo "==> Building images"
podman build -t localhost/open-assistant-backend:latest  "$APP_DIR/backend"
podman build -t localhost/open-assistant-frontend:latest "$APP_DIR/frontend"

echo "==> Creating network"
podman network exists open-assistant || podman network create open-assistant

echo "==> (Re)creating containers"
for c in caddy frontend backend; do podman rm -f "$c" >/dev/null 2>&1 || true; done

podman create --name backend --network open-assistant --restart always \
  -e PORT=8080 -e DB_PATH=/data/logs.db -e CRED_DB_PATH=/creds/user.db \
  -v "$APP_DIR/data/backend:/data:z" \
  -v "$APP_DIR/data/frontend:/creds:ro,z" \
  localhost/open-assistant-backend:latest

podman create --name frontend --network open-assistant --restart always \
  --env-file "$APP_DIR/.env" --env-file "$APP_DIR/frontend.env" \
  -e NODE_ENV=production -e PORT=3000 \
  -e BACKEND_URL=http://backend:8080 -e USER_DB=/data/user.db \
  -v "$APP_DIR/data/frontend:/data:z" \
  localhost/open-assistant-frontend:latest

podman create --name caddy --network open-assistant --restart always \
  -p 80:80 -p 443:443 -p 443:443/udp \
  --env-file "$APP_DIR/.env" \
  -v "$APP_DIR/Caddyfile:/etc/caddy/Caddyfile:ro,z" \
  -v "$APP_DIR/data/caddy/data:/data:z" \
  -v "$APP_DIR/data/caddy/config:/config:z" \
  docker.io/library/caddy:2-alpine

echo "==> Generating systemd units"
tmp="$(mktemp -d)"
(cd "$tmp" && podman generate systemd --new --name --files backend frontend caddy >/dev/null)
install -m 644 "$tmp"/container-*.service "$UNIT_DIR/"
rm -rf "$tmp"

# `generate systemd` emits no cross-container ordering; add it so caddy and the
# frontend don't start before their upstream is up.
install -d -m 755 "$UNIT_DIR/container-frontend.service.d" \
                  "$UNIT_DIR/container-caddy.service.d"
cat > "$UNIT_DIR/container-frontend.service.d/deps.conf" <<'EOF'
[Unit]
Requires=container-backend.service
After=container-backend.service
EOF
cat > "$UNIT_DIR/container-caddy.service.d/deps.conf" <<'EOF'
[Unit]
Requires=container-frontend.service
After=container-frontend.service
EOF

# The units recreate containers from scratch (--new); drop the templates.
for c in caddy frontend backend; do podman rm -f "$c" >/dev/null 2>&1 || true; done

echo "==> Enabling and starting"
systemctl daemon-reload
systemctl enable --now container-backend.service
systemctl enable --now container-frontend.service
systemctl enable --now container-caddy.service

echo
systemctl --no-pager --lines=0 status \
  container-backend container-frontend container-caddy 2>/dev/null || true
podman ps

cat <<EOF

Done. Watch TLS issuance with:
    journalctl -u container-caddy -f
EOF
