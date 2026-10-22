---
name: whatsapp-bridge
description: >-
  Use when pairing, starting, sending, or receiving WhatsApp via the Baileys
  HTTP bridge — programmatic zero-token listener, webhook wake for LLM reply on
  WhatsApp, allowlist, draft-then-send, logout/re-pair. Primary host is the
  Mac mini (Tailscale Serve). A remote box must not start the bridge. Not Meta
  Cloud API.
---
# WhatsApp Baileys bridge + programmatic listener + webhook wake

Grok WhatsApp Bridge: a Baileys HTTP API. **Primary = Mac mini.** Reach it via Mac localhost or Tailscale Serve — never the public internet. Upstream MIT code lives in NousResearch/hermes-agent `scripts/whatsapp-bridge`.

A git checkout at `/workspace/whatsapp-bridge` (or wherever this repo is cloned) is source. It is not a running bridge.

## Where it runs

**Primary = Mac mini.** The bridge process runs there (`./start.sh`, `./pair.sh`, optional `./start-listener.sh`), bound to loopback. Tailscale Serve:

- `https://leos-mac-mini.tail48056.ts.net/`
- `GET /health` returns HTTP 200 when the process is up. `status` is `connected` once WhatsApp is linked. HTTP 200 while the Mac is still showing a QR means the process is up and waiting for that scan.
- Serve sends `Host: leos-mac-mini.tail48056.ts.net`. The Mac `.env` sets `WHATSAPP_TRUSTED_HOSTS=leos-mac-mini.tail48056.ts.net`, or that request is HTTP 400. Do not add a public hostname. Do not use Tailscale Funnel.

**NAS cleaned. Not Primary.** The Synology bridge is not in use. Do not start a NAS container for this. `docs/docker-synology.md` is an optional / legacy tutorial only.

**Box** (any host that is not the Mac mini, including a cloud agent). Do not start or run the bridge. Do not `npm ci`, `./start.sh`, `./pair.sh`, `./start-listener.sh`, or `docker compose up` on the Box to bring a bridge up.

**`/send` prefers Mac localhost.** When the shell is on the Mac, `POST http://127.0.0.1:37100/send`. From the Box, you may try Mac Serve `https://leos-mac-mini.tail48056.ts.net` with a client timeout of **at most 3 seconds**. If it does not answer, stop and report that. Do not fall back to starting a bridge.

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
5. Do not change the agent gateway config. Unofficial API — no bulk spam.
6. **The Box does not run the bridge.** Primary process is the Mac mini. `/send` prefers `http://127.0.0.1:37100` on that Mac. The Box may call `https://leos-mac-mini.tail48056.ts.net` with a timeout of at most 3 seconds and must not start or supervise `bridge.js`.

## One-time setup (Mac mini only)

Run this on the Mac mini. The Box does not run it. The NAS is not Primary.

```bash
cd /path/to/whatsapp-baileys-bridge   # Mac mini checkout, not the Box
cp .env.example .env
# Quote EVERY value that has spaces/colons (Authorization headers):
#   WHATSAPP_WAKE_WEBHOOK_AUTH="Bearer …"
#   WHATSAPP_TRUSTED_HOSTS=leos-mac-mini.tail48056.ts.net
npm ci
./pair.sh              # QR → Linked Devices
./start.sh             # nohup/tmux/systemd
curl -sS http://127.0.0.1:37100/health   # process up; connected or waiting for QR
tailscale serve --bg 37100               # tailnet HTTPS → 127.0.0.1:37100
curl -sS --max-time 3 https://leos-mac-mini.tail48056.ts.net/health
nohup ./start-listener.sh > /tmp/wa-listener.log 2>&1 &
```

`start-listener.sh` must **not** `source .env` with bare bash if values contain spaces — parse quoted `.env` (python + `shlex.quote`) then `exec node listener.mjs`.

Docker on Synology is optional / legacy, not Primary. The NAS bridge has been cleaned. The image pull pin in `docker-compose.yml` stays `ghcr.io/coke1120/grok-whatsapp-bridge:v1.3.2` (no `build:`). Do not `docker compose build` or `up --build` on Synology or in Portainer. `Dockerfile` is built in GitHub Actions; `./start.sh` and `./pair.sh` stay the Mac mini path. Publish `127.0.0.1:37100` only. Never Funnel and never a public bind. If bridge-network DNS/egress dies (`EAI_AGAIN`, no QR), use `docker-compose.host-net.yml` (`network_mode: host`, `WHATSAPP_BIND_HOST=127.0.0.1`) — that overlay is not the default. `WHATSAPP_TRUSTED_HOSTS` defaults to `bridge` in Compose and must include the Serve MagicDNS name when Serve sends that `Host`. Primary name: `leos-mac-mini.tail48056.ts.net`. Older NAS example: `leohofamily.tail48056.ts.net`. Session state is the `wa-session` / `wa-sessions` volumes; do not delete them on upgrade. Details: `docs/docker-synology.md`.

## .env keys

| Key | Purpose |
|-----|---------|
| `WHATSAPP_BRIDGE_PORT` | default `37100` |
| `WHATSAPP_BIND_HOST` | unset = `127.0.0.1`. Default compose forces `0.0.0.0` inside the container and publishes loopback. Host-network overlay forces `127.0.0.1`. Never `0.0.0.0` with host networking |
| `WHATSAPP_TRUSTED_HOSTS` | Mac mini Primary: `leos-mac-mini.tail48056.ts.net` so Serve's Host is accepted. Leave it unset only when every caller uses a loopback Host. Compose defaults to `bridge` and does not override `.env` or Portainer. Optional Compose example: `bridge,leos-mac-mini.tail48056.ts.net`. Do not put a public hostname here |
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
2. `POST /send` short reply to `chatId` when standing permission exists. Same host rule as manual send: Mac localhost, or Mac Serve from the Box with a timeout of at most 3 seconds.
3. One-line note in agent chat; stay silent if empty/duplicate.

Wire panel fields: Webhook URL + Authorization header → secret form → `.env` → restart listener.

chatId may be `@lid` (Linked Identity); `/send` accepts it — do not force `@s.whatsapp.net` if inbox gave `@lid`.

## Manual send (user-asked outbound)

1. `GET /health` → `connected`. Prefer Mac localhost `http://127.0.0.1:37100/health`. From the Box, `https://leos-mac-mini.tail48056.ts.net/health` with a timeout of at most 3 seconds.
2. Draft in chat; wait for approve (unless standing permission covers it).
3. `POST /send` `{"chatId":"…","message":"…"}` on that same base URL. Prefer Mac localhost.
4. Report status; no spam retries. If Serve does not answer within 3 seconds, stop. Do not start a bridge on the Box.

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
curl -sS http://127.0.0.1:37100/health
# status/session describe the default account; accounts[] lists each status
curl -sS -X POST http://127.0.0.1:37100/accounts/sales/send \
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
curl -sS -X POST http://127.0.0.1:37100/accounts/sales/pause
./pair.sh sales
curl -sS -X POST http://127.0.0.1:37100/accounts/sales/resume
```

Single-session `./logout.sh` still ends the bridge process after unlink. Multi-account `loggedOut` does not. Do not `rm -rf session` when only one named account needs a new QR.

## Logout / re-pair

Mac mini only. The Box does not run this, and does not start a replacement bridge.

```bash
pkill -f 'node bridge.js' || true
pkill -f 'node listener.mjs' || true
rm -rf session/*
./pair.sh && ./start.sh
nohup ./start-listener.sh > /tmp/wa-listener.log 2>&1 &
```

Ask the user to unlink the old device in WhatsApp → Linked Devices if it still shows.

## Health checklist

- On the Mac: `pgrep -af 'bridge.js|listener.mjs'`
- Prefer `curl -sS --max-time 3 http://127.0.0.1:37100/health` on the Mac
- From the Box: `curl -sS --max-time 3 https://leos-mac-mini.tail48056.ts.net/health`, then stop. Do not start the bridge
- On the Mac, tail `/tmp/wa-bridge.log`, `/tmp/wa-listener.log` (look for `wake 200` vs `401`)
- Latest `inbox.jsonl` on the Mac

## Export (safe package)

Ship source + `package.json` + scripts + skill copy; **omit** `session/`, `node_modules/`, real `.env`, `inbox.jsonl`, `listener-state.json`. Include `.env.example` with empty placeholders.

## Out of scope

- Meta WhatsApp Business Cloud API
- Agent gateway config edits
- Public unauthenticated exposure of the Baileys port
- Cron polling WhatsApp for wakes
