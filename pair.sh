#!/usr/bin/env bash
# One-shot QR pairing (pair-only). Scan with Linked Devices; the process exits after connect.
#   ./pair.sh           # legacy single session (./session unless WHATSAPP_SESSION_DIR is already exported)
#   ./pair.sh sales     # one named account from WHATSAPP_ACCOUNTS or accounts/sales.env
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
ACCOUNT="${1:-${WHATSAPP_ACCOUNT:-}}"

if [[ -n "$ACCOUNT" ]]; then
  # shellcheck disable=SC1091
  eval "$(python3 "$ROOT/load_dotenv.py" "$ROOT/.env")"
  PORT="${WHATSAPP_BRIDGE_PORT:-37100}"
  export WHATSAPP_MODE="${WHATSAPP_MODE:-bot}"
  if [[ ! -d node_modules ]]; then
    npm ci
  fi
  if curl -fsS -X POST "http://127.0.0.1:${PORT}/accounts/${ACCOUNT}/pause" >/dev/null 2>&1; then
    echo "Paused \"${ACCOUNT}\" on the running bridge so pairing can use its session directory."
    echo "If you cancel, resume with: curl -sS -X POST http://127.0.0.1:${PORT}/accounts/${ACCOUNT}/resume"
  fi
  set +e
  node bridge.js --port "$PORT" --mode "$WHATSAPP_MODE" --pair-only --account "$ACCOUNT"
  code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    if curl -fsS -X POST "http://127.0.0.1:${PORT}/accounts/${ACCOUNT}/resume" >/dev/null 2>&1; then
      echo "Resumed \"${ACCOUNT}\" on the running bridge."
    fi
  else
    echo "Pairing did not finish. If the bridge paused \"${ACCOUNT}\", resume with:" >&2
    echo "  curl -sS -X POST http://127.0.0.1:${PORT}/accounts/${ACCOUNT}/resume" >&2
  fi
  exit "$code"
fi

PORT="${WHATSAPP_BRIDGE_PORT:-37100}"
SESSION="${WHATSAPP_SESSION_DIR:-$ROOT/session}"
mkdir -p "$SESSION"
export WHATSAPP_MODE="${WHATSAPP_MODE:-bot}"
if [[ ! -d node_modules ]]; then
  npm ci
fi
exec node bridge.js --port "$PORT" --session "$SESSION" --mode "$WHATSAPP_MODE" --pair-only
