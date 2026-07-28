#!/usr/bin/env bash
# One-shot deploy: push this working tree to the server and redeploy.
#
#     bash deploy.sh                # test, sync, rebuild, restart, verify
#     bash deploy.sh --skip-tests   # skip the local test gate
#
# Databases are never touched: this syncs into a staging dir (~/oa-deploy), and
# the installer then syncs on to /mnt/storage/open-assistant with /data excluded,
# so user.db, logs.db and the Caddy certs stay put.
set -euo pipefail

HOST="${OA_HOST:-oa}"
STAGE="${OA_STAGE:-oa-deploy}"          # relative to $HOME on the server
DOMAIN="$(grep -E '^DOMAIN=' .env 2>/dev/null | cut -d= -f2- || true)"
DOMAIN="${DOMAIN:-oa.laion.ai}"

cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ "${1:-}" != "--skip-tests" ]]; then
  echo "==> Running frontend tests"
  (cd frontend && bun test)
fi

echo "==> Syncing working tree to $HOST:~/$STAGE"
# --delete keeps the staging dir honest; it holds no state of its own.
# .env / frontend.env ARE included — the deployment needs them.
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist \
  --exclude '/data' --exclude 'frontend/data' \
  ./ "$HOST:$STAGE/"

echo "==> Redeploying on $HOST"
# Keep the full transcript but print only the phase headers on success; on
# failure show the tail and stop, so a broken deploy can't be reported as OK.
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
if ! ssh "$HOST" "bash ~/$STAGE/deploy/install-rootless.sh" >"$log" 2>&1; then
  echo "    DEPLOY FAILED — last 40 lines:"
  sed 's/^/    /' <<<"$(tail -40 "$log")"
  exit 1
fi
grep -E '^==> ' "$log" | sed 's/^==> /  - /' || true

echo "==> Verifying https://$DOMAIN"
# The installer restarts the backend at the end, so Caddy can briefly 502.
# Poll rather than judging the deploy on a single racy sample.
code=000
for _ in $(seq 1 15); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "https://$DOMAIN/" || echo 000)"
  [[ "$code" == "200" ]] && break
  sleep 2
done
if [[ "$code" == "200" ]]; then
  echo "    OK — $DOMAIN returned 200"
  # Confirm the *new* build is serving, not just that something answers.
  want="$(grep -m1 '"version"' frontend/package.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
  got="$(curl -sS "https://$DOMAIN/api/health" | sed 's/.*"version":"\([^"]*\)".*/\1/' || echo '?')"
  if [[ "$got" == "$want" ]]; then
    echo "    OK — serving version $got"
  else
    echo "    WARNING: live version is '$got' but this tree is '$want'"
  fi
else
  echo "    WARNING: $DOMAIN returned $code"
  echo "    Logs: ssh $HOST 'journalctl --user -u container-caddy -n 50'"
  exit 1
fi
