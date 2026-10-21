#!/usr/bin/env bash
# Long-running bridge. Keep this process up (launchd/systemd/tmux).
# No multi config: one session, same flags as before.
# WHATSAPP_ACCOUNTS or accounts/*.env: every account, this port, no --session.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PORT="${WHATSAPP_BRIDGE_PORT:-37100}"
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

multi=0
if [[ -n "${WHATSAPP_ACCOUNTS:-}" ]]; then
  multi=1
else
  accounts_dir="${WHATSAPP_ACCOUNTS_DIR:-$ROOT/accounts}"
  if [[ -d "$accounts_dir" ]]; then
    shopt -s nullglob
    env_files=("$accounts_dir"/*.env)
    shopt -u nullglob
    if [[ ${#env_files[@]} -gt 0 ]]; then
      multi=1
    fi
  fi
fi

if [[ "$multi" -eq 1 ]]; then
  exec node bridge.js --port "$PORT" --mode "$WHATSAPP_MODE"
fi
exec node bridge.js --port "$PORT" --session "$SESSION" --mode "$WHATSAPP_MODE"
