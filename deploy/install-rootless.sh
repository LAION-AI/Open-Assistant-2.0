#!/usr/bin/env bash
# Open Assistant 2.0 — ROOTLESS podman deployment (user systemd units).
#
# Run as your normal user (NOT root, NOT sudo) ON THE SERVER:
#     bash ~/oa-deploy/deploy/install-rootless.sh
#
# Why rootless: this kernel is built without CONFIG_CGROUP_BPF, so crun cannot
# create the cgroup-v2 device controller (it is an eBPF program) and *rootful*
# containers die at creation with "bpf create ``: Function not implemented".
# Rootless podman does not set up device cgroups, so it works. Three one-time
# root steps are required first — the preflight below prints them if missing.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/mnt/storage/open-assistant}"
UNIT_DIR="$HOME/.config/systemd/user"

BE_IMAGE=localhost/open-assistant-backend:latest
FE_IMAGE=localhost/open-assistant-frontend:latest
CADDY_IMAGE=docker.io/library/caddy:2-alpine

[[ $EUID -ne 0 ]] || { echo "ERROR: run as your normal user, not root/sudo"; exit 1; }

# --- preflight ---------------------------------------------------------------
fail=0
port_start="$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null || echo 1024)"
if (( port_start > 80 )); then
  echo "MISSING: rootless podman cannot bind 80/443 (ip_unprivileged_port_start=$port_start)"
  fail=1
fi
# Containers run as this user, so the data directories — not just APP_DIR —
# must be writable by it, or the databases fail to open at runtime.
if ! mkdir -p "$APP_DIR"/data/{frontend,backend} "$APP_DIR"/data/caddy/{data,config} 2>/dev/null \
   || ! touch "$APP_DIR/data/frontend/.wtest" 2>/dev/null; then
  echo "MISSING: $APP_DIR and $APP_DIR/data must be writable by $USER"
  fail=1
else
  rm -f "$APP_DIR/data/frontend/.wtest"
fi
if (( fail )); then
  cat <<EOF

Run these once as root, then re-run this script:

    sudo sh -c 'echo "net.ipv4.ip_unprivileged_port_start=80" > /etc/sysctl.d/99-oa-rootless.conf && sysctl -p /etc/sysctl.d/99-oa-rootless.conf'
    sudo mkdir -p $APP_DIR && sudo chown -R $USER:$USER $APP_DIR
    sudo loginctl enable-linger $USER
EOF
  exit 1
fi
loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q 'Linger=yes' \
  || echo "WARNING: linger is off — services stop when you log out (sudo loginctl enable-linger $USER)"

echo "==> Staging application into $APP_DIR"
mkdir -p "$APP_DIR"/data/{frontend,backend} "$APP_DIR"/data/caddy/{data,config}
if [[ "$SRC_DIR" == "$APP_DIR" ]]; then
  echo "    (running from the deployed copy — no sync needed)"
else
  rsync -a --delete \
    --exclude 'node_modules' --exclude '.git' --exclude 'dist' --exclude '/data' \
    "$SRC_DIR"/ "$APP_DIR"/
fi

for f in .env frontend.env; do
  [[ -f "$APP_DIR/$f" ]] || { echo "ERROR: missing $APP_DIR/$f"; exit 1; }
  chmod 600 "$APP_DIR/$f"
done
grep -q '^ALLOWED_HOSTS=' "$APP_DIR/.env" \
  || { echo "ERROR: .env must set ALLOWED_HOSTS (WebAuthn RP id)"; exit 1; }

# Rootless podman stores images under $HOME by default. Here $HOME lives on a
# small RAM-backed overlay, and because overlay-on-overlay isn't supported podman
# falls back to the `vfs` driver, which copies every layer in full — two builds
# are enough to fill the disk. Point storage at the ZFS pool instead: terabytes
# free, and it survives the reboots that wipe $HOME.
#
# (fuse-overlayfs would be more space-efficient than vfs, but podman refuses
# `overlay` over zfs without a mount_program and the driver choice is pinned in
# libpod's database, so switching it means tearing the stack down. Not worth it
# when the pool has 2 TB free.)
ensure_container_storage() {
  local conf="$HOME/.config/containers/storage.conf"
  local want="$APP_DIR/containers"
  if [[ -f "$conf" ]] && grep -qF "graphroot = \"$want\"" "$conf"; then return 0; fi

  echo "==> Moving podman storage to $want (was ${HOME}/.local/share/containers)"
  # Containers currently running are managed by the *old* storage; stop them
  # before switching or podman loses track of them while they keep the ports.
  systemctl --user stop container-caddy container-frontend container-backend 2>/dev/null || true
  for c in caddy frontend backend; do podman rm -f "$c" >/dev/null 2>&1 || true; done

  mkdir -p "$(dirname "$conf")" "$want"
  cat > "$conf" <<EOF
# Managed by deploy/install-rootless.sh
[storage]
driver = "vfs"
graphroot = "$want"
runroot = "/run/user/$(id -u)/containers"
EOF
  # Reclaim the old location so the root filesystem isn't left full. Layer files
  # are owned by mapped subuids, so plain rm can't touch them — do it inside the
  # user namespace. Never fatal: freeing space must not block the deploy.
  podman unshare rm -rf "$HOME/.local/share/containers" 2>/dev/null || true
  rm -rf "$HOME/.local/share/containers" 2>/dev/null || true
}
ensure_container_storage

echo "==> Building images"
podman build -t "$BE_IMAGE" "$APP_DIR/backend"
podman build -t "$FE_IMAGE" "$APP_DIR/frontend"
podman pull "$CADDY_IMAGE"

# vfs keeps a full copy per layer, so untagged intermediates from previous
# deploys add up quickly. Drop anything no longer referenced.
podman image prune -f >/dev/null 2>&1 || true

echo "==> Creating network"
podman network exists open-assistant || podman network create open-assistant

echo "==> (Re)creating containers"
# Stop the services first. Their units run `podman run --replace`, so removing a
# container while its service is live just makes systemd recreate it — and the
# `podman create` below then fails with "name is already in use".
systemctl --user stop container-caddy container-frontend container-backend 2>/dev/null || true
for c in caddy frontend backend; do podman rm -f "$c" >/dev/null 2>&1 || true; done

podman create --name backend --network open-assistant --restart always \
  -e PORT=8080 -e DB_PATH=/data/logs.db -e CRED_DB_PATH=/creds/user.db \
  -v "$APP_DIR/data/backend:/data" \
  -v "$APP_DIR/data/frontend:/creds:ro" \
  "$BE_IMAGE" >/dev/null

podman create --name frontend --network open-assistant --restart always \
  --env-file "$APP_DIR/.env" --env-file "$APP_DIR/frontend.env" \
  -e NODE_ENV=production -e PORT=3000 \
  -e BACKEND_URL=http://backend:8080 -e USER_DB=/data/user.db \
  -v "$APP_DIR/data/frontend:/data" \
  "$FE_IMAGE" >/dev/null

podman create --name caddy --network open-assistant --restart always \
  -p 80:80 -p 443:443 -p 443:443/udp \
  --env-file "$APP_DIR/.env" \
  -v "$APP_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$APP_DIR/data/caddy/data:/data" \
  -v "$APP_DIR/data/caddy/config:/config" \
  "$CADDY_IMAGE" >/dev/null

echo "==> Generating user systemd units"
mkdir -p "$UNIT_DIR"
tmp="$(mktemp -d)"
# podman 4.3.1's `generate systemd` takes exactly one container per call.
(cd "$tmp" && for c in backend frontend caddy; do
  podman generate systemd --new --name --files "$c" >/dev/null
done)
install -m 644 "$tmp"/container-*.service "$UNIT_DIR/"
rm -rf "$tmp"

# `generate systemd` emits no cross-container ordering. Use Wants= rather than
# Requires=: we only need start ordering. Requires= also propagates *stops*, so
# restarting the backend would tear down the frontend and the Caddy edge with it.
mkdir -p "$UNIT_DIR/container-frontend.service.d" "$UNIT_DIR/container-caddy.service.d"
cat > "$UNIT_DIR/container-frontend.service.d/deps.conf" <<'EOF'
[Unit]
Wants=container-backend.service
After=container-backend.service
EOF
cat > "$UNIT_DIR/container-caddy.service.d/deps.conf" <<'EOF'
[Unit]
Wants=container-frontend.service
After=container-frontend.service
EOF

# The units recreate containers from scratch (--new); drop the templates.
for c in caddy frontend backend; do podman rm -f "$c" >/dev/null 2>&1 || true; done

echo "==> Enabling and starting"
systemctl --user daemon-reload
systemctl --user enable --now container-backend.service
systemctl --user enable --now container-frontend.service

# The backend opens the read-only credential store once at startup (main.go).
# On a first deploy user.db does not exist until the frontend has migrated, so
# /api/ingest would stay disabled until something restarts it. Do that here,
# before Caddy comes up, so the edge is never bounced.
echo "==> Waiting for user.db, then restarting backend so /api/ingest works"
for _ in $(seq 1 60); do
  [[ -f "$APP_DIR/data/frontend/user.db" ]] && break
  sleep 1
done
if [[ -f "$APP_DIR/data/frontend/user.db" ]]; then
  systemctl --user restart container-backend.service
  systemctl --user is-active --quiet container-frontend.service \
    || systemctl --user restart container-frontend.service
else
  echo "    WARNING: user.db never appeared; check 'journalctl --user -u container-frontend'"
fi

# Caddy last, once its upstreams have settled.
systemctl --user enable --now container-caddy.service

echo
systemctl --user --no-pager --lines=0 status \
  container-backend container-frontend container-caddy 2>/dev/null || true
podman ps

cat <<EOF

Done. Watch TLS issuance with:
    journalctl --user -u container-caddy -f

NOTE: \$HOME is wiped on reboot in this rescue environment, so the units and
images are lost (data on $APP_DIR survives). After a reboot, re-run:
    bash $APP_DIR/deploy/install-rootless.sh
EOF
