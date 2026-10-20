#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
eval "$(python3 <<'PY'
from pathlib import Path
import shlex
p = Path(".env")
if p.exists():
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            quote = v[0]
            v = v[1:-1]
            out = []
            i = 0
            while i < len(v):
                if v[i] == "\\" and i + 1 < len(v):
                    nxt = v[i + 1]
                    if nxt == "n":
                        out.append("\n")
                        i += 2
                        continue
                    if nxt in "\\\"":
                        out.append(nxt)
                        i += 2
                        continue
                out.append(v[i])
                i += 1
            v = "".join(out)
        print(f"export {k}={shlex.quote(v)}")
PY
)"
export WHATSAPP_BRIDGE_URL="${WHATSAPP_BRIDGE_URL:-http://127.0.0.1:${WHATSAPP_BRIDGE_PORT:-3100}}"
export WHATSAPP_ALLOWED_USERS="${WHATSAPP_ALLOWED_USERS:-}"
exec node listener.mjs
