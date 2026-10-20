#!/usr/bin/env bash
# Long-running bridge. Keep this process up (launchd/systemd/tmux).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PORT="${WHATSAPP_BRIDGE_PORT:-3100}"
SESSION="${WHATSAPP_SESSION_DIR:-$ROOT/session}"
mkdir -p "$SESSION"
export WHATSAPP_MODE="${WHATSAPP_MODE:-bot}"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
exec node bridge.js --port "$PORT" --session "$SESSION" --mode "$WHATSAPP_MODE"
