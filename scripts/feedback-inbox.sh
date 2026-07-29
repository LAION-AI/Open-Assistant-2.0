#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -f frontend.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source frontend.env
  set +a
fi

: "${FEEDBACK_TOKEN:?FEEDBACK_TOKEN must be set in frontend.env or the environment}"

domain="${DOMAIN:-}"
if [[ -z "$domain" && -f .env ]]; then
  domain="$(grep -E '^DOMAIN=' .env | head -1 | cut -d= -f2- || true)"
fi
domain="${domain:-oa.laion.ai}"
endpoint="https://${domain}/api/feedback/automation"

case "${1:-list}" in
  list)
    curl --fail --silent --show-error \
      -H "Authorization: Bearer ${FEEDBACK_TOKEN}" \
      "$endpoint"
    ;;
  done|dismissed)
    id="${2:-}"
    [[ "$id" =~ ^[0-9]+$ ]] || {
      echo "Usage: $0 {list|done ID|dismissed ID}" >&2
      exit 2
    }
    curl --fail --silent --show-error \
      -X POST \
      -H "Authorization: Bearer ${FEEDBACK_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{\"id\":${id},\"status\":\"$1\"}" \
      "$endpoint"
    ;;
  *)
    echo "Usage: $0 {list|done ID|dismissed ID}" >&2
    exit 2
    ;;
esac
