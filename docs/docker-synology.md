# Docker and Synology

The image runs the same `bridge.js` / `listener.mjs` as `./start.sh` and `./start-listener.sh`. Bare metal keeps using those scripts. Docker does not replace them.

**Never publish the bridge to the open internet.** The HTTP API has no authentication. Compose binds `127.0.0.1` on the host. Do not change that to `3100:3100` or `0.0.0.0:3100:3100`, do not forward the port on the router, do not put it behind Web Station or a public reverse proxy, and do not use Tailscale Funnel. Reach it from the NAS itself, an SSH tunnel, or Tailscale Serve to loopback. See [ADR 0002](adr/0002-docker-loopback-publish.md).

The image listens on `0.0.0.0` **inside the container** so Docker's port mapping can connect. Requests still need a loopback `Host` (`127.0.0.1` or `localhost`). A LAN IP in the `Host` header gets HTTP 400.

## Files

| Path | Role |
|------|------|
| `Dockerfile` | Node 22 multi-stage image. Starts as root, chowns session volumes, drops to `node` (uid 1000). |
| `docker-compose.yml` | `bridge`, optional `listener` profile, optional `pair` one-shot. |
| `.env` | Copy from `.env.example`. Not in git. Compose loads it with `env_file`. |

Baileys needs Node 20+. The image is Node 22. `ffmpeg` is not installed; media that needs a transcode is sent as a file instead.

## Any Docker host

```bash
cp .env.example .env
chmod 600 .env
# Set WHATSAPP_ALLOWED_USERS to E.164 digits, no plus.
docker compose up -d --build
docker compose logs -f bridge          # first-time QR
curl -sS http://127.0.0.1:3100/health
```

`WHATSAPP_SESSION_DIR` in `.env` is overridden inside the container to `/app/session`, which is the `wa-session` volume. A host path in that variable is not used.

Leave the container user empty (root at process start). The entrypoint drops to `node` after `chown`. Forcing uid 1000 in the UI before the first start leaves a root-owned volume that Baileys cannot write.

## Synology Container Manager

DSM 7.2+ with Container Manager. The NAS needs outbound internet for the first image build and for WhatsApp.

1. Install **Container Manager** from Package Center.
2. Put a checkout on a share, for example `/volume1/docker/grok-whatsapp-bridge` (`git clone` over SSH, or upload the project with File Station). The folder must contain `docker-compose.yml`, `Dockerfile`, and `accounts/`.
3. Over SSH:

   ```bash
   cd /volume1/docker/grok-whatsapp-bridge
   cp .env.example .env
   chmod 600 .env
   ```

   Edit `.env`. Set `WHATSAPP_ALLOWED_USERS`. Leave `WHATSAPP_BIND_HOST` unset. Do not commit `.env` or `session/`.
4. Container Manager → **Project** → **Create**.
5. Project name: `grok-whatsapp-bridge`. Keep this name. Volume names are prefixed with it (`grok-whatsapp-bridge_wa-session`). A different project name attaches empty volumes and looks like a logout.
6. Path: the folder that already contains `docker-compose.yml`. Use that file. If the wizard shows the YAML, leave the port as `127.0.0.1:...`.
7. Do not enable a Web Station portal, a QuickConnect port, or a router forward for 3100. Do not turn on high privilege.
8. Build and start. The first build pulls `node:22-bookworm-slim` and runs `npm ci`.
9. Open the bridge container log, or from SSH: `sudo docker compose logs -f bridge`. Scan the QR (WhatsApp → Linked devices).
10. On the NAS, over SSH: `curl -sS http://127.0.0.1:3100/health`. `status` stays `disconnected` or `connecting` until the scan finishes. HTTP 200 from `/health` means the process is up, not that WhatsApp is linked.
11. Container Manager → **Volume**. Keep `grok-whatsapp-bridge_wa-session` and `grok-whatsapp-bridge_wa-sessions`. Deleting them deletes the WhatsApp login.

Older DSM builds may only have the `docker-compose` command (with a hyphen). Use whichever one is installed. A plain Project start does **not** pass `--profile listener`.

## Listener

The listener is off unless you enable the `listener` profile. It shares the bridge network namespace and polls `http://127.0.0.1:3100`. Inbox files live in the `wa-listener` volume (`/app/listener-data`), not in the image.

```bash
sudo docker compose --profile listener up -d
sudo docker compose logs -f listener
```

To start it from the Container Manager project screen, edit the project YAML and delete the listener service's `profiles:` line, then build again. Putting the listener on the Compose network under the hostname `bridge` fails the loopback Host check (HTTP 400). Leave `network_mode: "service:bridge"`.

## Tailscale and SSH

From a laptop, the NAS loopback is not your loopback. Two ways in:

**SSH tunnel**

```bash
ssh -L 3100:127.0.0.1:3100 user@nas
curl -sS http://127.0.0.1:3100/health
```

**Tailscale Serve** (tailnet only), with the Tailscale package or container on the NAS:

```bash
sudo tailscale serve --bg 3100
```

That proxies the tailnet to `http://127.0.0.1:3100` and keeps a loopback `Host`. Do not run `tailscale funnel`. Funnel puts the bridge on the public internet.

If a client gets `Invalid Host header`, the proxy forwarded a public or LAN name. Point the upstream at `127.0.0.1` and do not rewrite `Host` to the tailnet or QuickConnect name.

## Host network

Prefer the published `127.0.0.1` mapping. Use host networking only when that mapping cannot be created. Then remove `ports:` and set `WHATSAPP_BIND_HOST=127.0.0.1`. Wildcard bind plus host networking listens on every NAS interface, including LAN.

`docker-compose.override.yml` is gitignored for that kind of local change.

## First QR, and a one-shot pair

**First link.** `docker compose up -d`, then `docker compose logs -f bridge`. The running process prints the QR and keeps the session on `wa-session`. You do not need a second container.

**One-shot, bridge stopped** (single session, or a full re-pair):

```bash
docker compose stop bridge
docker compose run --rm --no-deps -it -e WHATSAPP_PAIR_CONFIRM=1 bridge pair
docker compose up -d bridge
```

`WHATSAPP_PAIR_CONFIRM=1` is required so a normal `up` cannot start a pairing run. Stop the bridge first. Two processes must not write one session directory.

**One named account while the bridge stays up** (other accounts keep their sockets):

```bash
docker compose run --rm -it -e WHATSAPP_PAIR_CONFIRM=1 pair sales
```

That container joins the bridge network, pauses `sales`, runs `bridge.js --pair-only --account sales`, and resumes the account when the scan succeeds. The same pause/resume contract as `./pair.sh sales`.

## Multi-account volumes

One container, one port, one socket per account. Same rules as [ADR 0001](adr/0001-multi-account-single-process.md).

| In-container path | Volume | Config |
|-------------------|--------|--------|
| `/app/session` | `wa-session` | Single account, or the primary `sessionDir` `./session` |
| `/app/sessions/<name>` | `wa-sessions` | Extra accounts, for example `./sessions/sales` |

`accounts/*.env.example` is not an account. Copy one:

```bash
cp accounts/sales.env.example accounts/sales.env
chmod 600 accounts/sales.env
```

```
WHATSAPP_SESSION_DIR=./sessions/sales
```

Working directory in the container is `/app`, so `./sessions/sales` is the `wa-sessions` volume. JSON works the same (`accounts.example.json`). Set `WHATSAPP_ACCOUNTS=./accounts.json` and uncomment the `accounts.json` mount on **bridge and listener**. `accounts.json` is gitignored.

Do not copy credential files from one session directory into another.

## Bring an existing bare-metal session

With the bridge stopped, and the old `session/` directory on the NAS:

```bash
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v /volume1/docker/grok-whatsapp-bridge/session:/from:ro \
  bridge -c 'cp -a /from/. /app/session/ && chown -R node:node /app/session'
docker compose up -d bridge
```

Keep the old directory until `/health` shows `connected`. Do not delete `wa-session` to "refresh" a working login.

## Upgrade

Session data is in the volumes, not the image.

```bash
cd /volume1/docker/grok-whatsapp-bridge
git pull
sudo docker compose build
sudo docker compose up -d
# if you use the listener:
sudo docker compose --profile listener up -d
```

Do not `docker compose down -v`. Do not delete `wa-session`, `wa-sessions`, or `wa-listener` in Container Manager. Rebuilding the image does not touch them.

`restart: unless-stopped` brings the process back after a reboot or a crash. It does not delete sessions. After an intentional single-account logout the process exits and Docker starts it again until you stop the container and re-pair. Details: [reconnect.md](reconnect.md).

## Health

`/health` returns HTTP 200 while the process is up, including `disconnected`, `connecting`, and the QR wait. The Docker healthcheck uses that on purpose, so a scan or a short 408 does not restart the container. WhatsApp linked is `"status":"connected"` in the JSON. The check calls `http://127.0.0.1:$WHATSAPP_BRIDGE_PORT/health` from inside the container.
