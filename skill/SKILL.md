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

Collect URL/auth via a masked secret form — never ask the user to paste secrets in chat.

## Programmatic listener

Files: `listener.mjs`, `start-listener.sh`. Artifacts: `inbox.jsonl`, `unread.flag`, `listener-state.json`.

1. Poll `GET /messages` every `WHATSAPP_POLL_MS`.
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
