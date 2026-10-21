---
name: whatsapp-bridge
description: >-
  Use when pairing, starting, sending, or receiving WhatsApp via the Baileys
  HTTP bridge — programmatic zero-token listener, webhook wake for LLM reply on
  WhatsApp, allowlist, draft-then-send, logout/re-pair. Not Meta Cloud API.
---
# WhatsApp Baileys bridge + programmatic listener + webhook wake

Standalone Baileys bridge (from Hermes Agent `scripts/whatsapp-bridge`). HTTP API on an always-on host; the agent reaches it via localhost / Tailscale — never the public internet.

Default install path on this bot: `/workspace/whatsapp-bridge` (adjust if you cloned elsewhere).

## Architecture (token model)

| Layer | What | Tokens |
|-------|------|--------|
| `bridge.js` | Baileys session + `/health` `/send` `/messages` | none |
| `listener.mjs` | Poll `/messages`, allowlist, `inbox.jsonl`, optional fixed ack, **POST webhook** | none |
| Webhook routine (optional) | Wakes the agent only when inbound arrives | **one turn per message** |

Do **not** use a cron poll routine to watch WhatsApp — that burns tokens even when quiet. Prefer programmatic listen → webhook wake.

## Hard rules

1. **Outbound** is under the linked WhatsApp identity. Default: draft in chat, send only after explicit approve for *this* message. Exceptions the user may grant:
   - Fixed `WHATSAPP_PROGRAMMATIC_ACK` (no LLM).
   - Standing permission: on webhook wake, reply on WhatsApp with `POST /send` without draft-wait.
2. **Allowlist** `WHATSAPP_ALLOWED_USERS` (E.164 digits, no `+`). Bridge + listener both gate. Empty allowlist = nobody inbound.
3. **Session is secret** (`session/`). Never commit, paste, or put in Notion/cloud memory. Export packages must omit `session/` and real `.env` secrets.
4. Prefer `WHATSAPP_MODE=bot` (dedicated/bot number). `self-chat` only for Message-yourself inbound.
5. Do not change Hermes gateway config. Unofficial API — no bulk spam.

## One-time setup (host)

```bash
cd /path/to/whatsapp-baileys-bridge   # or /workspace/whatsapp-bridge
cp .env.example .env
# Quote EVERY value that has spaces/colons (Authorization headers):
#   WHATSAPP_WAKE_WEBHOOK_AUTH="Bearer …"
npm ci
./pair.sh              # QR → Linked Devices
./start.sh             # nohup/tmux/systemd
curl -s http://127.0.0.1:3100/health   # connected
nohup ./start-listener.sh > /tmp/wa-listener.log 2>&1 &
```

`start-listener.sh` must **not** `source .env` with bare bash if values contain spaces — parse quoted `.env` (python + `shlex.quote`) then `exec node listener.mjs`.

## .env keys

| Key | Purpose |
|-----|---------|
| `WHATSAPP_BRIDGE_PORT` | default `3100` |
| `WHATSAPP_MODE` | `bot` \| `self-chat` |
| `WHATSAPP_ALLOWED_USERS` | comma-separated digits (required for inbound) |
| `WHATSAPP_PROGRAMMATIC_ACK` | fixed ack text; empty = off |
| `WHATSAPP_WAKE_WEBHOOK_URL` | routine webhook URL (secret form) |
| `WHATSAPP_WAKE_WEBHOOK_AUTH` | `Bearer …` only (strip leading `Authorization:` if the panel gave the full header) |
| `WHATSAPP_POLL_MS` | listener poll interval (default 2000) |
| `WHATSAPP_RECONNECT_BASE_MS` | first non-logout reconnect delay (default 3000) |
| `WHATSAPP_RECONNECT_CAP_MS` | backoff cap (default 60000) |
| `WHATSAPP_ACCOUNTS` | optional JSON or path; unset = single session |
| `WHATSAPP_DEFAULT_ACCOUNT` | which account unqualified `/send` and `/messages` use |

Collect URL/auth via a masked secret form — never ask the user to paste secrets in chat.

## Programmatic listener

Files: `listener.mjs`, `start-listener.sh`. Artifacts: `inbox.jsonl`, `unread.flag`, `listener-state.json`.

1. Poll `GET /messages` every `WHATSAPP_POLL_MS`. With multi-account config, poll each `/accounts/<name>/messages` instead (the shipped listener does this). HTTP 408/503, a not-connected body, or health `disconnected` / `connecting` / `reconnecting` is a reconnect window: retry that poll a few times, warn once, and keep looping. Other HTTP errors warn once and are not retried.
2. Dedupe; append to `inbox.jsonl`; skip non-allowlist.
3. If `WHATSAPP_WAKE_WEBHOOK_URL` set: `POST` JSON `{source,chatId,senderId,senderName,body,hasMedia,ts}` with `Authorization` header when auth set. Expect **401** without auth.
4. Optional fixed ack via `/send` when `WHATSAPP_PROGRAMMATIC_ACK` non-empty (usually off when webhook replies).

Boot log should show `wake=on` / `ack=off` as configured. Diagnose with `/tmp/wa-listener.log` (`wake 401` = missing/bad auth).

## Webhook wake routine (LLM reply on WhatsApp)

Create a **webhook-only** routine (no cron). Prompt intent:

1. Read wake payload and/or latest `inbox.jsonl` line; clear `unread.flag`.
2. `POST /send` short reply to `chatId` when standing permission exists.
3. One-line note in agent chat; stay silent if empty/duplicate.

Wire panel fields: Webhook URL + Authorization header → secret form → `.env` → restart listener.

chatId may be `@lid` (Linked Identity); `/send` accepts it — do not force `@s.whatsapp.net` if inbox gave `@lid`.

## Manual send (user-asked outbound)

1. `GET /health` → `connected`.
2. Draft in chat; wait for approve (unless standing permission covers it).
3. `POST /send` `{"chatId":"…","message":"…"}`.
4. Report status; no spam retries.

## Modes / chatId

- DM classic: `<digits>@s.whatsapp.net`
- DM LID: `<id>@lid` (common on inbound)
- Group: `…@g.us` only if explicitly asked

## Multi-account

`WHATSAPP_ALLOWED_USERS` is still the inbound allowlist. It does not create accounts.

No `WHATSAPP_ACCOUNTS` and no `accounts/*.env` means one session, one socket, legacy `/health` JSON, and the commands above. Do not move an already-paired `session/` when you upgrade.

Several named numbers share **one process and one port** (one Baileys socket each). Config is either:

- `WHATSAPP_ACCOUNTS` — JSON, or a path such as `./accounts.json` (that filename is gitignored). Copy `accounts.example.json`.
- `accounts/<name>.env` — copy `accounts/sales.env.example`. `*.env.example` is not loaded. If both styles exist, the JSON wins.

Give the existing `./session` directory to the default account (`default` in the JSON, or `WHATSAPP_DEFAULT_ACCOUNT`, or the first account). Other accounts get new empty directories such as `./sessions/sales`. Never copy creds between them. Never commit session dirs, `accounts.json`, or `accounts/*.env`.

```bash
./pair.sh sales
./start.sh
curl -sS http://127.0.0.1:3100/health
# status/session describe the default account; accounts[] lists each status
curl -sS -X POST http://127.0.0.1:3100/accounts/sales/send \
  -H 'content-type: application/json' \
  -d '{"chatId":"<jid from inbox>","message":"hi"}'
```

Account selection, and they must not disagree:

| How | Example |
| --- | --- |
| Path | `/accounts/sales/send` |
| Header | `X-WhatsApp-Account: sales` |
| Query | `/send?account=sales` |
| None | Default account. This is what old `/send` and `/messages` clients hit. |

`/health?account=sales` is that account only. `allConnected` is false when any account is not `connected`. A watchdog that only checks top-level `status` is watching the default account.

The listener polls **each** account. Inbox lines and webhook bodies include `account`. Ack and wake can be overridden per account (`WHATSAPP_PROGRAMMATIC_ACK`, `WHATSAPP_WAKE_WEBHOOK_URL`, `WHATSAPP_WAKE_WEBHOOK_AUTH` in that account's env file or JSON). A custom poller that only calls `GET /messages` still sees only the default account.

Per-account allowlist: `allowedUsers` / `WHATSAPP_ALLOWED_USERS` on that account. If the key is omitted, the process allowlist is used.

```bash
./logout.sh sales          # unlink sales; other accounts stay up
./pair.sh sales            # pauses sales on a live bridge, QR, resumes after success
```

Re-pair without logout (bridge already running):

```bash
curl -sS -X POST http://127.0.0.1:3100/accounts/sales/pause
./pair.sh sales
curl -sS -X POST http://127.0.0.1:3100/accounts/sales/resume
```

Single-session `./logout.sh` still ends the bridge process after unlink. Multi-account `loggedOut` does not. Do not `rm -rf session` when only one named account needs a new QR.

## Logout / re-pair

```bash
pkill -f 'node bridge.js' || true
pkill -f 'node listener.mjs' || true
rm -rf session/*
./pair.sh && ./start.sh
nohup ./start-listener.sh > /tmp/wa-listener.log 2>&1 &
```

Ask the user to unlink the old device in WhatsApp → Linked Devices if it still shows.

## Health checklist

- `pgrep -af 'bridge.js|listener.mjs'`
- `curl -s localhost:3100/health`
- Tail `/tmp/wa-bridge.log`, `/tmp/wa-listener.log` (look for `wake 200` vs `401`)
- Latest `inbox.jsonl`

## Export (safe package)

Ship source + `package.json` + scripts + skill copy; **omit** `session/`, `node_modules/`, real `.env`, `inbox.jsonl`, `listener-state.json`. Include `.env.example` with empty placeholders.

## Out of scope

- Meta WhatsApp Business Cloud API
- Hermes gateway edits
- Public unauthenticated exposure of the Baileys port
- Cron polling WhatsApp for wakes
