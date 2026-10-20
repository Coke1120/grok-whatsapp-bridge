# grok-whatsapp-bridge (Grok Bot / Cursor plugin)

Marketplace plugin that ships the **whatsapp-bridge** agent skill plus the runnable Baileys HTTP bridge sources in this repo.

| Piece | What you get |
|-------|----------------|
| Plugin skill | `skills/whatsapp-bridge/SKILL.md` — when/how to pair, send, listen, wake |
| Bridge runtime | `bridge.js` + `listener.mjs` — run on your always-on host (loopback / Tailscale only) |

**Install (after marketplace approval):** search Marketplace for `grok-whatsapp-bridge`, or install from this public GitHub repo.

**Not included:** session credentials, real `.env`, inbox history, or phone numbers.

---

## Runtime: WhatsApp Baileys HTTP bridge

Based on [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) `scripts/whatsapp-bridge` (MIT); this repo adds a **zero-LLM** allowlist listener, optional **webhook wake**, and skill packaging.

> Unofficial WhatsApp Web API (Baileys). Prefer a dedicated spare number. Do not bulk-spam. Bind to loopback and reach it only via Tailscale / SSH tunnel / authenticated reverse proxy — never expose the bridge port to the public internet.

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | connected? |
| GET | `/messages` | long-poll inbound |
| POST | `/send` | `{ "chatId", "message" }` |
| POST | `/send-media` | media |
| … | `/edit`, `/typing`, `/read`, … | see `bridge.js` |

Default bind: `127.0.0.1:3100`.

## Quick start

Needs Node 18+.

```bash
cp .env.example .env
# set WHATSAPP_ALLOWED_USERS to E.164 digits (no +), comma-separated
npm ci
./pair.sh              # scan QR: WhatsApp → Linked Devices
./start.sh             # keep running (tmux/systemd)
curl -s http://127.0.0.1:3100/health
./start-listener.sh    # optional: allowlist poll + inbox.jsonl + webhook
```

## Token model

| Layer | Role | LLM tokens |
|-------|------|------------|
| `bridge.js` | Baileys session + HTTP | none |
| `listener.mjs` | Poll `/messages`, allowlist, `inbox.jsonl`, optional fixed ack, POST webhook | none |
| Your agent / webhook routine | Replies only when inbound arrives | only on wake |

Do **not** cron-poll the agent just to watch WhatsApp.

## Environment

See `.env.example`. Important:

- `WHATSAPP_ALLOWED_USERS` — required for inbound; empty means nobody is accepted
- `WHATSAPP_MODE` — `bot` (recommended) or `self-chat`
- `WHATSAPP_WAKE_WEBHOOK_URL` / `WHATSAPP_WAKE_WEBHOOK_AUTH` — optional agent wake
- `WHATSAPP_PROGRAMMATIC_ACK` — fixed ack text; empty = off
- `session/` — **secret**; never commit

`start-listener.sh` parses quoted `.env` values (so `Bearer …` auth works).

## Agent skill

Copy [`skill/SKILL.md`](skill/SKILL.md) into your agent skill library (e.g. Grok Bot workflows) for pairing, send rules, webhook wake, and logout/re-pair.

## Safety / what this repo never ships

- No `session/` credentials
- No real `.env`
- No `inbox.jsonl` / message history
- No personal phone numbers as defaults

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
