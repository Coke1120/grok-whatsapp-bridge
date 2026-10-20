#!/usr/bin/env bash
# One-shot QR pairing (pair-only). Scan with Linked Devices, then Ctrl+C after connected.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PORT="${WHATSAPP_BRIDGE_PORT:-3100}"
SESSION="${WHATSAPP_SESSION_DIR:-$ROOT/session}"
mkdir -p "$SESSION"
export WHATSAPP_MODE="${WHATSAPP_MODE:-bot}"
if [[ ! -d node_modules ]]; then
  npm ci
fi
exec node bridge.js --port "$PORT" --session "$SESSION" --mode "$WHATSAPP_MODE" --pair-only
