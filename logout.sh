#!/usr/bin/env bash
# Unlink one account on the running bridge. Does not delete session files itself.
#   ./logout.sh         # default account (the only account when multi is off)
#   ./logout.sh sales   # that account; other accounts keep running
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
eval "$(python3 "$ROOT/load_dotenv.py" "$ROOT/.env")"
ACCOUNT="${1:-}"
PORT="${WHATSAPP_BRIDGE_PORT:-37100}"
export WHATSAPP_BRIDGE_PORT="$PORT"
if ! node "$ROOT/bridge_http_client.mjs" logout "$ACCOUNT"; then
  echo "Logout request failed. Check API authentication and the existing bridge; do not delete session files as a fallback." >&2
  exit 1
fi

echo
if [[ -n "$ACCOUNT" ]]; then
  echo "Account ${ACCOUNT} logged out. Other accounts keep running."
  echo "Re-pair: ./pair.sh ${ACCOUNT}"
else
  echo "Logged out. In single-session mode the bridge exits after unlink."
  echo "Re-pair: ./pair.sh"
fi
