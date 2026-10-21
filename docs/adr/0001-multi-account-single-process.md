# ADR 0001 — One process, one socket per WhatsApp account

## Status

Accepted. 2026-10-21.

## Context

The bridge was one Baileys socket and one `useMultiFileAuthState` directory. `WHATSAPP_ALLOWED_USERS` is an inbound allowlist, not a list of linked numbers. Operators who need two WhatsApp identities (a bot line and an ops line, for example) had to run two checkouts and two ports.

Old clients call `GET /health`, `GET /messages`, and `POST /send` with no account name. An upgrade with no new config must keep that behavior, including the `/health` JSON shape and the `./session` directory.

## Decision

Run **one Node process**, **one loopback HTTP server**, and **one Baileys socket per named account**.

- No `WHATSAPP_ACCOUNTS` and no `accounts/*.env`: a single implicit account. Unqualified routes and `/health` match the previous bridge. `./start.sh` / `./pair.sh` with no name still pass `--session`.
- Otherwise each account has a `name` and its own `sessionDir`. Accounts connect together. Send queues are per socket (overlapping sends on one socket can cross chats; different accounts may send at the same time).
- Unqualified `/health`, `/messages`, and `/send` use the **default** account (`WHATSAPP_DEFAULT_ACCOUNT`, else the JSON `default`, else the first account). Top-level `status` and `session` describe that default account so an existing watchdog keeps watching the number it watched before.
- A caller names an account with `/accounts/<name>/...`, the `X-WhatsApp-Account` header, or `?account=`. If those disagree, the request is rejected.
- `loggedOut` on the implicit single account still exits the process. With multi config, that account is marked `logged_out` and the others stay up. Reconnect timers and backoff counters are per account.
- A non-logout close waits `min(cap, base × 2^attempt)` with a little jitter (default base 3s, cap 60s). `open` resets that account's counter. Code 515 stays about 1s and does not advance the counter. `WHATSAPP_RECONNECT_BASE_MS` and `WHATSAPP_RECONNECT_CAP_MS` override the defaults.
- `listener.mjs` polls each account and puts `account` on inbox rows and webhook bodies. A poller that only calls `/messages` still sees only the default account.

Config is either `WHATSAPP_ACCOUNTS` (JSON or a path to JSON) or `accounts/<name>.env`. If both exist, the JSON wins. `accounts/*.env.example` is not an account. Session directories and real env files stay uncommitted.

## Alternatives

Separate processes plus a reverse proxy would isolate a crashed socket from the others. It also adds a supervisor, a second port map, and a second way to target an account. The shared process already dies today if the single socket's Node process dies; per-socket reconnect covers the common 408. Operators who want OS isolation can run another checkout on another port. That layout is not what `./start.sh` does.

Putting account names in `WHATSAPP_ALLOWED_USERS` was rejected. That variable stays the inbound allowlist.

## Consequences

- A fault that takes down the Node process takes down every account. A fault that closes one socket does not.
- Pairing one account while the bridge is up must pause that socket first so two processes do not write the same session directory. `./pair.sh <name>` does this when the bridge answers.
- Watchdogs that only read top-level `status` do not notice a secondary account that is down. `accounts[]` and `allConnected` are there for that.
- Do not copy credential files between session directories, and do not delete `session/` when only one named account needs a new QR.
- Close storms seen on 2026-10-21 were bursty and lined up across two bridges on different ports, which points at shared WhatsApp or network noise. Backoff stays per socket so one account's longer outage does not stretch the other. A second OS process is not the fix for that noise.
