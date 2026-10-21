#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
eval "$(python3 "$ROOT/load_dotenv.py" "$ROOT/.env")"
export WHATSAPP_BRIDGE_URL="${WHATSAPP_BRIDGE_URL:-http://127.0.0.1:${WHATSAPP_BRIDGE_PORT:-3100}}"
export WHATSAPP_ALLOWED_USERS="${WHATSAPP_ALLOWED_USERS:-}"
exec node listener.mjs
