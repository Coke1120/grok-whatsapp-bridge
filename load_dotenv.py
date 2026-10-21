#!/usr/bin/env python3
"""Print shell `export` lines for a dotenv file. Missing files print nothing."""
from pathlib import Path
import shlex
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else ".env")
if not path.exists():
    raise SystemExit(0)

for line in path.read_text().splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
        out = []
        i = 0
        while i < len(value):
            if value[i] == "\\" and i + 1 < len(value):
                nxt = value[i + 1]
                if nxt == "n":
                    out.append("\n")
                    i += 2
                    continue
                if nxt in "\\\"":
                    out.append(nxt)
                    i += 2
                    continue
            out.append(value[i])
            i += 1
        value = "".join(out)
    print(f"export {key}={shlex.quote(value)}")
