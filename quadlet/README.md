# Podman quadlet deployment

Systemd-native alternative to `docker-compose.yml` — the same three services
(Caddy edge → Bun frontend → Go backend), the same bind-mounted state under
`data/`, managed by systemd via [Podman quadlets](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html).

## Layout assumption

The units reference the repo at **`/opt/open-assistant`**. If you deploy
elsewhere, replace that prefix in every `.container`/`.build` file
(`sed -i 's#/opt/open-assistant#/your/path#g' *.container *.build`).

## Setup (rootful, recommended for ports 80/443)

```sh
# 1. Get the code and state directories in place
sudo git clone https://github.com/LAION-AI/Open-Assistant-2.0 /opt/open-assistant
cd /opt/open-assistant
sudo mkdir -p data/caddy/data data/caddy/config data/frontend data/backend

# 2. Configuration
#    .env         — DOMAIN, ACME_EMAIL, ALLOWED_HOSTS (same value as DOMAIN),
#                   optional EMAIL / EMAIL_PASSWORD / EMAIL_OUTGOING_SERVER /
#                   EMAIL_OUTGOING_SMTP_PORT
#    frontend.env — JWT_SECRET, FEEDBACK_TOKEN
#
#    Note: compose expands `ALLOWED_HOSTS: ${DOMAIN}` itself; systemd doesn't,
#    so .env must set ALLOWED_HOSTS explicitly (WebAuthn RP id = your domain).
sudoedit /opt/open-assistant/.env
sudoedit /opt/open-assistant/frontend.env

# 3. Install the units
sudo cp quadlet/*.container quadlet/*.build quadlet/*.network /etc/containers/systemd/
sudo systemctl daemon-reload

# 4. Build images + start the stack (the .build units build on first start;
#    Podman < 5.0: build manually with `podman build -t localhost/open-assistant-frontend:latest ./frontend`
#    and the same for ./backend, and delete the .build units)
sudo systemctl start oa-backend oa-frontend oa-caddy
sudo systemctl status oa-caddy
```

Quadlet units are started by systemd at boot (`[Install] WantedBy=`); there is
no `systemctl enable` step for generated units.

## Rootless

Copy the units to `~/.config/containers/systemd/` and use `systemctl --user`
instead. Two caveats:

- Rootless Podman can't bind ports 80/443 by default:
  `sudo sysctl net.ipv4.ip_unprivileged_port_start=80` (persist in
  `/etc/sysctl.d/`), or publish higher ports and front them elsewhere.
- Keep the repo somewhere your user owns and rewrite the `/opt/open-assistant`
  paths (see above). Add `loginctl enable-linger $USER` so the stack survives
  logout.

## Operations

```sh
sudo systemctl restart oa-frontend          # restart one service
sudo journalctl -u oa-backend -f            # logs
sudo systemctl start oa-frontend-build      # rebuild an image after git pull
sudo systemctl restart oa-frontend
```

Updating: `git pull`, rerun the `-build` units (or `podman build …`), then
restart the containers. All persistent state stays in `/opt/open-assistant/data`
exactly as with compose, so you can switch between compose and quadlet freely.
