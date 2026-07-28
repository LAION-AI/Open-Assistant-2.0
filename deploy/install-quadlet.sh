#!/usr/bin/env bash
# Install Open Assistant 2.0 as rootful podman quadlet units (quadlet/*).
#
# Run as root ON THE SERVER:
#     sudo bash ~/oa-deploy/deploy/install-quadlet.sh
#
# Rootful is deliberate: Caddy binds 80/443 (rootless podman can't, below
# net.ipv4.ip_unprivileged_port_start=1024) and /mnt/storage is root-owned.
# Persistent state stays on the ZFS pool under $APP_DIR/data.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${APP_DIR:-/mnt/storage/open-assistant}"
UNIT_DIR="/etc/containers/systemd"

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

# crun implements the cgroup-v2 device controller as an eBPF program. Without
# CONFIG_CGROUP_BPF every *rootful* container dies at creation with
# "bpf create ``: Function not implemented" — no podman setting works around a
# missing kernel feature. Rootless podman never sets up device cgroups.
ensure_cgroup_bpf() {
  local cfg=""
  if [[ -r /proc/config.gz ]]; then cfg="$(zcat /proc/config.gz 2>/dev/null || true)"; fi
  if [[ -z "$cfg" && -r "/boot/config-$(uname -r)" ]]; then cfg="$(cat "/boot/config-$(uname -r)")"; fi
  [[ -z "$cfg" ]] && return 0                      # can't tell — let podman speak
  grep -q '^CONFIG_CGROUP_BPF=y' <<<"$cfg" && return 0
  cat >&2 <<MSG
ERROR: kernel $(uname -r) is built without CONFIG_CGROUP_BPF, so rootful
containers cannot be created on this host ("bpf create: Function not
implemented"). This script cannot work here.

Use the rootless deployment instead:

    bash ${SRC_DIR}/deploy/install-rootless.sh

MSG
  exit 1
}
ensure_cgroup_bpf

# --- preflight: quadlet needs podman >= 4.4 ----------------------------------
if [[ ! -x /usr/libexec/podman/quadlet && ! -x /usr/lib/podman/quadlet ]]; then
  cat >&2 <<'EOF'
ERROR: quadlet is not installed.

Quadlet ships with podman >= 4.4; this host has 4.3.1 (Debian 12 main, and
bookworm-backports carries no newer podman). Either upgrade podman, or use the
pre-quadlet path which produces the same topology on 4.3.1:

    sudo bash deploy/install-systemd-fallback.sh

Re-run this script once `podman --version` reports 4.4 or newer.
EOF
  exit 1
fi

echo "==> Staging application into $APP_DIR"
install -d -m 755 "$APP_DIR"
install -d -m 755 "$APP_DIR/data/frontend" "$APP_DIR/data/backend"
install -d -m 755 "$APP_DIR/data/caddy/data" "$APP_DIR/data/caddy/config"

# Source tree (build context + Caddyfile). /data is excluded so existing
# databases are never clobbered by a redeploy.
# When re-run from the deployed copy itself (e.g. after a reboot), source and
# destination are the same directory — rsyncing would be a no-op at best, and it
# would silently mask the fact that no new code arrived. Skip it explicitly.
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
  || { echo "ERROR: .env must set ALLOWED_HOSTS (WebAuthn RP id); systemd does not expand \${DOMAIN}"; exit 1; }

# .build units need podman >= 5.0; below that, build the images here.
if ! podman --version | grep -qE ' 5\.'; then
  echo "==> podman < 5.0: building images directly (skipping .build units)"
  podman build -t localhost/open-assistant-backend:latest  "$APP_DIR/backend"
  podman build -t localhost/open-assistant-frontend:latest "$APP_DIR/frontend"
  BUILD_UNITS=()
else
  BUILD_UNITS=("$APP_DIR"/quadlet/*.build)
fi

echo "==> Installing quadlet units into $UNIT_DIR"
install -d -m 755 "$UNIT_DIR"
install -m 644 "$APP_DIR"/quadlet/*.network "$UNIT_DIR/"
install -m 644 "$APP_DIR"/quadlet/*.container "$UNIT_DIR/"
[[ ${#BUILD_UNITS[@]} -gt 0 ]] && install -m 644 "${BUILD_UNITS[@]}" "$UNIT_DIR/"

echo "==> Reloading systemd (runs the quadlet generator)"
systemctl daemon-reload

echo "==> Starting stack"
systemctl start oa-backend.service
systemctl start oa-frontend.service
systemctl start oa-caddy.service

echo
systemctl --no-pager --lines=0 status oa-backend oa-frontend oa-caddy 2>/dev/null || true
podman ps

cat <<EOF

Done. Watch TLS issuance with:
    journalctl -u oa-caddy -f

Units are regenerated from $UNIT_DIR on every daemon-reload; edit the
.container files there (or re-run this script) rather than 'systemctl edit'.
EOF
