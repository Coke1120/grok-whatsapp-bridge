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

Grok WhatsApp Bridge adds a **zero-LLM** allowlist listener, optional **webhook wake**, and skill packaging. The Baileys bridge code started from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) `scripts/whatsapp-bridge` (MIT).

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

Default bind: `127.0.0.1:37100`.

## Quick start

Needs Node 18+.

```bash
cp .env.example .env
# set WHATSAPP_ALLOWED_USERS to E.164 digits (no +), comma-separated
npm ci
./pair.sh              # scan QR: WhatsApp → Linked Devices
./start.sh             # keep running (tmux/systemd)
curl -s http://127.0.0.1:37100/health
./start-listener.sh    # optional: allowlist poll + inbox.jsonl + webhook
```

## Docker (GHCR, Synology, Portainer)

`./start.sh`, `./pair.sh`, and `./start-listener.sh` stay the bare-metal path. `Dockerfile` is what GitHub Actions builds. `docker-compose.yml` only **pulls**.

Image: `ghcr.io/coke1120/grok-whatsapp-bridge:v1.3.1` (and `:latest` on each publish). The repo is public, so `docker pull` does not need a login unless the package is later made private. Pin a tag. Do not attach image tarballs to GitHub Releases.

**Never publish the bridge to the open internet.** Compose maps `127.0.0.1:37100` on the host only. Do not change that to `37100:37100`, do not forward the port, and do not use Tailscale Funnel. The HTTP API has no login. `curl` HTTP 200 on `/health` means the process is up, not that WhatsApp is linked. `curl` HTTPS 200 on `https://web.whatsapp.com` is not a working WebSocket (WSS).

**Do not `docker compose build` or `up --build` on Synology or in Portainer.** On-NAS `npm ci` hangs (the NAS is x86_64; this is not an arm gap). There is no reliable Buildx on the NAS. Dev hosts that want a local image use `docker-compose.build.yml`.

```bash
cp .env.example .env
chmod 600 .env
docker compose pull
docker compose up -d
docker compose logs -f bridge    # first QR; session stays on the wa-session volume
curl -sS http://127.0.0.1:37100/health
docker compose --profile listener up -d
```

Portainer: set variables in the stack environment UI. Do not use a relative `env_file: .env`. `WHATSAPP_TRUSTED_HOSTS` defaults to `bridge` and can be extended from that UI or from `.env` (Tailscale Serve MagicDNS). Example: `bridge,leohofamily.tail48056.ts.net`.

If Compose bridge DNS/egress dies (`EAI_AGAIN` for `web.whatsapp.com` inside the container, no QR, close 408) while the NAS host can resolve WhatsApp, use `docker-compose.host-net.yml`: host network and `WHATSAPP_BIND_HOST=127.0.0.1`. That file is not the default. Do not bind `0.0.0.0` on the host network.

WhatsApp → Linked devices may still show **Google Chrome (Hermes Agent)** until an image that contains the rename is running, and usually until the next link. Do not re-pair a working session only to change that label. Image `:v1.3.1` built from git tag `v1.3.1` is older than the rename.

Full steps (Container Manager, pull vs build, Tailscale / SSH, host network, one-shot pair, upgrade without wiping `session/`): [docs/docker-synology.md](docs/docker-synology.md).

## Token model

| Layer | Role | LLM tokens |
|-------|------|------------|
| `bridge.js` | Baileys session + HTTP | none |
| `listener.mjs` | Poll `/messages`, allowlist, `inbox.jsonl`, optional fixed ack, POST webhook | none |
| Your agent / webhook routine | Replies only when inbound arrives | only on wake |

Do **not** cron-poll the agent just to watch WhatsApp.

## Reconnect vs outer watchdog

Socket drops (often reason **408** or **428**) are handled **inside** the bridge: that account waits with exponential backoff (about 3s, doubling up to about 60s) and connects again. An open connection resets that account's counter. With no multi config, `loggedOut` exits the process and needs a manual re-pair. With multi config, only that account stops.

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
curl -sS http://127.0.0.1:37100/health
curl -sS -X POST http://127.0.0.1:37100/accounts/sales/send \
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
- `WHATSAPP_BIND_HOST` — leave unset on bare metal (`127.0.0.1`). Docker sets `0.0.0.0` inside the container and still publishes loopback on the host.
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
