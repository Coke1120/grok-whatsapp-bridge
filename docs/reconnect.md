# Reconnect and outer watchdog

This bridge has **two layers**. Most “disconnects” only need the first.

## Layer 1 — built into `bridge.js` (always on)

Baileys emits `connection.update`. On `connection === 'close'`:

| Disconnect reason | Behaviour |
|-------------------|-----------|
| `loggedOut` | Process **exits**. Do **not** auto-reconnect. Clear `session/` only after the owner confirms, then `./pair.sh`. The scheduler is cancelled. |
| `515` (restart after pairing) | Reconnect after ~**1s**. This does not advance the backoff counter. |
| Other (common: **408**, **428**) | Exponential backoff: `min(cap, base × 2^attempt)` with about ±20% jitter. Defaults are base **3s** and cap **60s** (`WHATSAPP_RECONNECT_BASE_MS`, `WHATSAPP_RECONNECT_CAP_MS`). First close still logs like `Connection closed (reason: 408). Reconnecting in 3s...`. |
| `connection === 'open'` | That account's attempt counter resets. |
| Reconnect `startSocket()` throws | Same exponential sequence as a close, then another try. |
| pause / logout | Scheduler cancelled. No backoff loop. |

Session files stay on disk, so a normal 408 usually **does not** need a new QR.

Relevant code: `createReconnectScheduler` in `bridge_helpers.js`; `connection.update` handler in `account_runtime.js`.

The listener treats HTTP **408** / **503**, a "not connected" body, and health states `disconnected` / `connecting` / `reconnecting` as a reconnect window. It retries that poll a few times (about 250ms, 500ms, 1s), warns **once**, and keeps polling. `logged_out`, `paused`, and other HTTP errors are not retried. A successful poll clears the warning.

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

## Multi-account

Each configured account has its own socket, reconnect timer, and attempt counter. A 408 on one account does not delay the others. Separate bridge processes can still see the same 408/428 burst when the network is noisy; per-account counters do not assume a second process is the cause. See [ADR 0001](./adr/0001-multi-account-single-process.md).

| Event | Single session (no multi config) | Multi config |
| --- | --- | --- |
| `loggedOut` | Process **exits**. Re-pair with `./pair.sh`. | That account becomes `logged_out`. Process stays up. `./logout.sh <name>` then `./pair.sh <name>`. |
| 408 / 515 / other close | Reconnect that socket | Reconnect **that** socket only |
| `/health` `status` | That session | The **default** account only. Read `accounts[]` or `allConnected` for the rest. |

Do not delete every session directory because one account needs a QR. Pause or log out that account, then pair it.

```bash
curl -sS -X POST http://127.0.0.1:3100/accounts/sales/pause
./pair.sh sales
curl -sS -X POST http://127.0.0.1:3100/accounts/sales/resume
```

`./pair.sh <name>` pauses and, after a successful scan, resumes that account when the bridge is already up.

## Bot prompt example

See [bot-prompt-reconnect.example.md](./bot-prompt-reconnect.example.md) for a pasteable instruction block you can give another agent.
