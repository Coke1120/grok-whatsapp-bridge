#!/usr/bin/env bash
# One-shot QR pairing. Authenticate and pause an existing named account first.
# An HTTP/authentication failure must never be treated as a stopped bridge.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
eval "$(python3 "$ROOT/load_dotenv.py" "$ROOT/.env")"
ACCOUNT="${1:-${WHATSAPP_ACCOUNT:-}}"
PORT="${WHATSAPP_BRIDGE_PORT:-37100}"
SESSION="${WHATSAPP_SESSION_DIR:-$ROOT/session}"
export WHATSAPP_MODE="${WHATSAPP_MODE:-bot}"
export WHATSAPP_BRIDGE_PORT="$PORT"

bridge_status=0
node "$ROOT/bridge_http_client.mjs" health || bridge_status=$?
if [[ "$bridge_status" -ne 0 && "$bridge_status" -ne 2 ]]; then
  echo "Cannot safely verify bridge state. Not pairing; check API authentication and connectivity." >&2
  exit 1
fi
paused=0
if [[ "$bridge_status" -eq 0 ]]; then
  if [[ -z "$ACCOUNT" ]]; then
    echo "A bridge is already running. Use its QR or stop it before one-shot pairing." >&2
    exit 1
  fi
  if ! node "$ROOT/bridge_http_client.mjs" pause "$ACCOUNT"; then
    echo "Bridge account could not be paused. Not pairing." >&2
    exit 1
  fi
  paused=1
  echo "Paused \"${ACCOUNT}\" on the running bridge."
  echo "If interrupted, resume with: node bridge_http_client.mjs resume ${ACCOUNT}"
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
if [[ -z "$ACCOUNT" ]]; then
  mkdir -p "$SESSION"
  exec node bridge.js --port "$PORT" --session "$SESSION" --mode "$WHATSAPP_MODE" --pair-only
fi
set +e
node bridge.js --port "$PORT" --mode "$WHATSAPP_MODE" --pair-only --account "$ACCOUNT"
code=$?
set -e
if [[ "$paused" -eq 1 ]]; then
  if [[ "$code" -eq 0 ]]; then
    if node "$ROOT/bridge_http_client.mjs" resume "$ACCOUNT"; then
      echo "Resumed \"${ACCOUNT}\" on the running bridge."
    else
      echo "Pairing completed, but resume failed. Review the existing bridge before retrying." >&2
      exit 1
    fi
  else
    echo "Pairing did not finish. Resume with: node bridge_http_client.mjs resume ${ACCOUNT}" >&2
  fi
fi
exit "$code"
