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
| GET | `/health` | connected? With multi config, also lists every account |
| GET | `/messages` | long-poll inbound for the default account |
| POST | `/send` | `{ "chatId", "message" }` on the default account |
| POST | `/send-media` | media |
| … | `/edit`, `/typing`, `/read`, `/logout`, `/pause`, `/resume` | see `bridge.js` |

The same paths exist under `/accounts/<name>/...`. A header `X-WhatsApp-Account: <name>` or `?account=<name>` selects an account too. If two selectors disagree, the bridge returns 400.

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

## Reconnect vs outer watchdog

Socket drops (often reason **408**) are handled **inside** `bridge.js`: that socket waits a few seconds and connects again. With no multi config, `loggedOut` exits the process and needs a manual re-pair. With multi config, only that account stops.

An optional **outer** watchdog only restarts the process if Node died or `/health` stays not `connected` for minutes — it must never delete `session/`.

Details: [docs/reconnect.md](docs/reconnect.md). Pasteable agent instructions: [docs/bot-prompt-reconnect.example.md](docs/bot-prompt-reconnect.example.md).

## Multi-account

One process, one loopback port, one Baileys socket per account. With no `WHATSAPP_ACCOUNTS` and no `accounts/*.env`, nothing here applies: `./session` and the routes above stay as they are. Design notes: [docs/adr/0001-multi-account-single-process.md](docs/adr/0001-multi-account-single-process.md).

Keep the already-paired directory as the default account. Do not copy credential files into a second folder.

```bash
cp accounts.example.json accounts.json   # gitignored; or accounts/<name>.env from the example
# point "primary" sessionDir at the existing ./session
./pair.sh sales                          # QR for that account only
./start.sh
curl -sS http://127.0.0.1:3100/health
curl -sS -X POST http://127.0.0.1:3100/accounts/sales/send \
  -H 'content-type: application/json' \
  -d '{"chatId":"<jid>","message":"hi"}'
```

`/health` without a selector still reports `status` and `session` for the **default** account (so an old watchdog keeps working) and adds `accounts[]` plus `allConnected`. `GET /messages` without a selector drains only that default account. `./start-listener.sh` polls every account and adds `account` to `inbox.jsonl` and the webhook JSON.

```bash
./logout.sh sales    # unlink one account; the process stays up
./pair.sh sales      # pauses that socket if the bridge is up, then resumes after a successful scan
```

Per-account `allowedUsers` overrides `WHATSAPP_ALLOWED_USERS` for that number. The allowlist is still not the list of accounts.

## Environment

See `.env.example`. Important:

- `WHATSAPP_ALLOWED_USERS` — required for inbound; empty means nobody is accepted
- `WHATSAPP_MODE` — `bot` (recommended) or `self-chat`
- `WHATSAPP_WAKE_WEBHOOK_URL` / `WHATSAPP_WAKE_WEBHOOK_AUTH` — optional agent wake
- `WHATSAPP_PROGRAMMATIC_ACK` — fixed ack text; empty = off
- `session/` — **secret**; never commit

`start-listener.sh` parses quoted `.env` values (so `Bearer …` auth works).

## Agent skill

[`skills/whatsapp-bridge/SKILL.md`](skills/whatsapp-bridge/SKILL.md) covers pairing, send rules, webhook wake, logout/re-pair, and multi-account.

## Safety / what this repo never ships

- No `session/` credentials
- No real `.env`
- No `inbox.jsonl` / message history
- No personal phone numbers as defaults

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
