# Reconnect and outer watchdog

This bridge has **two layers**. Most “disconnects” only need the first.

## Layer 1 — built into `bridge.js` (always on)

Baileys emits `connection.update`. On `connection === 'close'`:

| Disconnect reason | Behaviour |
|-------------------|-----------|
| `loggedOut` | Process **exits**. Do **not** auto-reconnect. Clear `session/` only after the owner confirms, then `./pair.sh`. |
| `515` (restart after pairing) | Reconnect after ~**1s** via `createReconnectScheduler` → `startSocket()`. |
| Other (common: **408**) | Reconnect after ~**3s**. Log looks like: `Connection closed (reason: 408). Reconnecting in 3s...` then `WhatsApp connected!`. |
| Reconnect `startSocket()` throws | Scheduler retries after ~**5s**. |

Session files stay on disk, so a normal 408 usually **does not** need a new QR.

Relevant code: `createReconnectScheduler` in `bridge_helpers.js`; `connection.update` handler in `bridge.js`.

**Implication:** If you run the same `bridge.js` / `./start.sh`, you already have automatic socket reconnect. You do not need a separate “reconnect plugin”.

## Layer 2 — outer process / health watchdog (optional)

Layer 1 only helps while the **Node process is still alive**. Add an outer check if you care about:

- host reboot / OOM / `kill`
- `bridge.js` or `listener.mjs` exited
- `/health` stuck not `connected` for minutes (not a brief 408 blip)

Suggested checks (every few minutes or your existing health cron):

```bash
pgrep -af 'bridge.js|listener.mjs'   # both if you use the listener
curl -sS http://127.0.0.1:3100/health   # expect {"status":"connected",...}
```

Allowed auto-actions:

- Missing `bridge.js` → restart with `./start.sh` (or your systemd/launchd unit). **Never** delete `session/`.
- Missing `listener.mjs` (if used) → `./start-listener.sh`.
- Brief `408` then `WhatsApp connected!` while process alive → **noop** (layer 1 already handled it).
- Still not `connected` after ~2 minutes, or process crash-loop → one light restart; if still bad, stop and ask the owner (may need re-pair).

Never without explicit owner approval: logout, wipe `session/`, change allowlist, change webhook secrets, bulk `/send`.

## Bot prompt example

See [bot-prompt-reconnect.example.md](./bot-prompt-reconnect.example.md) for a pasteable instruction block you can give another agent.
