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
if [[ -n "$ACCOUNT" ]]; then
  URL="http://127.0.0.1:${PORT}/accounts/${ACCOUNT}/logout"
else
  URL="http://127.0.0.1:${PORT}/logout"
fi

echo "POST ${URL}"
if ! curl -fsS -X POST "$URL"; then
  echo >&2
  echo "Logout request failed." >&2
  if [[ -n "$ACCOUNT" ]]; then
    echo "If the bridge is stopped, delete only that account's session directory (its sessionDir in WHATSAPP_ACCOUNTS or accounts/${ACCOUNT}.env) and run: ./pair.sh ${ACCOUNT}" >&2
  else
    echo "If the bridge is stopped: rm -rf session/* && ./pair.sh" >&2
  fi
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
