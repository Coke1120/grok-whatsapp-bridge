# Docker and Synology

The image runs the same `bridge.js` / `listener.mjs` as `./start.sh` and `./start-listener.sh`. Bare metal keeps using those scripts. Docker does not replace them. `Dockerfile` is the image source of truth. GitHub Actions builds it. The NAS pulls the result.

**Never publish the bridge to the open internet.** The HTTP API has no authentication. The default compose file binds `127.0.0.1` on the host. Do not change that to `37100:37100` or `0.0.0.0:37100:37100`, do not forward the port on the router, do not put it behind Web Station or a public reverse proxy, and do not use Tailscale Funnel. Reach it from the NAS itself, an SSH tunnel, or Tailscale Serve to loopback. See [ADR 0002](adr/0002-docker-loopback-publish.md) and [ADR 0003](adr/0003-ghcr-pull-not-nas-build.md).

On the default Compose bridge network the process listens on `0.0.0.0` **inside the container** so Docker's port mapping can connect. Requests still need a loopback `Host` (`127.0.0.1` or `localhost`), or a name listed in `WHATSAPP_TRUSTED_HOSTS`. A LAN IP or a public name in the `Host` header gets HTTP 400.

## Pull a pinned image

Image: `ghcr.io/coke1120/grok-whatsapp-bridge`

| Tag | When it moves |
|-----|----------------|
| `:vX.Y.Z` | GitHub Release published, or a `vX.Y.Z` tag push, or Actions **Publish GHCR image** with that tag. This is the pin. |
| `:latest` | Same publish. Do not pin the NAS to `:latest`. |

`docker-compose.yml` pins `ghcr.io/coke1120/grok-whatsapp-bridge:v1.3.1` on `bridge`, `listener`, and `pair`. Change all three when you move the pin (the YAML anchor `bridge-image` is one value).

```bash
docker pull ghcr.io/coke1120/grok-whatsapp-bridge:v1.3.1
```

The repository is public. Anonymous pull is the normal path. You do not `docker login` on the NAS. GitHub sometimes creates the first package as private; the publish workflow asks for public visibility. If `docker pull` is denied, an owner sets the package to **Public** once on the package page. Do not put a registry token on the NAS. If the package is later made private, `docker login ghcr.io` needs a classic PAT with `read:packages`.

Platforms are `linux/amd64` and `linux/arm64`. This NAS is **x86_64** and pulls **amd64**. arm64 is for other hosts. The on-NAS build failure was not an architecture miss.

The git tag `v1.3.1` does not contain the publish workflow. After this workflow file is on the default branch `main`, publish that existing tag without a new release:

```bash
gh workflow run publish-image.yml --ref main -f tag=v1.3.1
```

In the Actions tab: **Publish GHCR image** → **Run workflow** → tag `v1.3.1`. That checks out git tag `v1.3.1` and pushes `:v1.3.1` and `:latest`. `workflow_dispatch` does not appear until the workflow file is on `main`. A later `v*` release or tag push publishes itself when the tagged commit contains `.github/workflows/publish-image.yml`.

`:v1.3.1` is the tree at git tag `v1.3.1`. Later commits (including the linked-device rename below) are not in that image until a newer tag is published.

## Do not build on the NAS

Container Manager `docker compose build` and `docker compose up --build` have hung (kill the build PID) and failed at `npm ci` on the NAS. There is no reliable local Buildx there. An earlier workaround was a `linux/amd64` build on a Mac, then `docker save` / `docker load`. Do not do that. Actions already builds both architectures.

On Synology and in Portainer, never run:

- `docker compose build`
- `docker compose up --build`
- `docker compose up -d --build`
- `docker-compose --build`
- a project create that builds the Dockerfile

The committed `docker-compose.yml` has no `build:` key, so a normal project start can only pull. Do not copy `docker-compose.build.yml` into the NAS project. That file is for a dev host:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Environment

Secrets stay out of git and out of the image. `chmod 600` the env file. Do not commit `.env`, `session/`, or `accounts/*.env`.

The compose file does **not** use a relative `env_file:`. Portainer stacks often have no project directory, so `env_file: .env` fails or reads the wrong file. Compose interpolates variables into `environment:` instead.

**Container Manager and `docker compose` on the NAS.** Put the file next to `docker-compose.yml` (for example `/volume1/docker/grok-whatsapp-bridge/.env`). Compose loads that file for interpolation. This is not `env_file`.

**Portainer.** Enter the same keys in the stack environment UI. Do not add `env_file: .env`. If the stack has no checkout on disk, point `./accounts` at an absolute directory you add in the stack YAML, such as `/volume1/docker/grok-whatsapp-bridge/accounts`. Do not commit the real account files.

**Absolute env file, only if you edit the YAML yourself.** Some hosts have no stack UI. You may add an absolute path. Do not commit a relative one.

```yaml
env_file:
  - /volume1/docker/grok-whatsapp-bridge/.env
```

Keys set under `environment:` still win for Docker-specific values (`WHATSAPP_BIND_HOST`, `WHATSAPP_SESSION_DIR`, listener paths). `WHATSAPP_TRUSTED_HOSTS` is taken from the project env so this file or the Portainer UI can extend it.

`WHATSAPP_SESSION_DIR` in `.env` is ignored inside the container. Compose sets `/app/session` (the `wa-session` volume). Leave `WHATSAPP_BIND_HOST` unset in `.env` for the default compose file. That file forces `0.0.0.0` inside the container so the published `127.0.0.1` port works. The host-network overlay sets `127.0.0.1` itself.

### Tailscale Serve and `WHATSAPP_TRUSTED_HOSTS`

Default is `bridge`, the Compose DNS name the listener uses. A hardcoded `bridge` used to override `.env`. The project env wins now.

Serve via MagicDNS can return **HTTP 400 Invalid Host** because the `Host` header is the tailnet name, not `127.0.0.1`. Add that name. Do not use Funnel. Do not add a public hostname.

```
WHATSAPP_TRUSTED_HOSTS=bridge,leohofamily.tail48056.ts.net
```

## Files

| Path | Role |
|------|------|
| `Dockerfile` | Node 22 multi-stage image. Starts as root, chowns session volumes, drops to `node` (uid 1000). Built in Actions, not on the NAS. |
| `docker-compose.yml` | Pulls the GHCR pin. `bridge`, optional `listener` profile, optional `pair` one-shot. No `build:`. |
| `docker-compose.host-net.yml` | Optional. Host network when bridge DNS/egress is dead. Not the default. |
| `docker-compose.build.yml` | Dev hosts only. |
| `.env` | Copy from `.env.example`. Not in git. Interpolated by Compose. Not a relative `env_file`. |

Baileys needs Node 20+. The image is Node 22. `ffmpeg` is not installed; media that needs a transcode is sent as a file instead.

## Any Docker host

```bash
cp .env.example .env
chmod 600 .env
# Set WHATSAPP_ALLOWED_USERS to E.164 digits, no plus.
docker compose pull
docker compose up -d
docker compose logs -f bridge          # first-time QR
curl -sS http://127.0.0.1:37100/health
```

Do not add `--build`.

Leave the container user empty (root at process start). The entrypoint drops to `node` after `chown`. Forcing uid 1000 in the UI before the first start leaves a root-owned volume that Baileys cannot write.

## Synology Container Manager

DSM 7.2+ with Container Manager. The NAS needs outbound internet to **pull** `ghcr.io` and to reach WhatsApp. It does not need to build Node or run `npm ci`.

1. Install **Container Manager** from Package Center.
2. Put a checkout or a copy of the project on a share, for example `/volume1/docker/grok-whatsapp-bridge`. The folder needs `docker-compose.yml`, `.env`, and `accounts/` if you use account files. It does **not** need `Dockerfile` or `docker-compose.build.yml`.
3. Over SSH:

   ```bash
   cd /volume1/docker/grok-whatsapp-bridge
   cp .env.example .env
   chmod 600 .env
   ```

   Edit `.env`. Set `WHATSAPP_ALLOWED_USERS`. Leave `WHATSAPP_BIND_HOST` unset. Do not commit `.env` or `session/`.
4. Container Manager → **Project** → **Create**.
5. Project name: `grok-whatsapp-bridge`. Keep this name. Volume names are prefixed with it (`grok-whatsapp-bridge_wa-session`). A different project name attaches empty volumes and looks like a logout.
6. Path: the folder that already contains `docker-compose.yml`. Use that file. If the wizard shows the YAML, leave the port as `127.0.0.1:...`. If it offers to build, do not build.
7. Do not enable a Web Station portal, a QuickConnect port, or a router forward for 37100. Do not turn on high privilege.
8. Pull and start. Do not run `docker compose build` or `up --build`. From SSH, if you start it yourself:

   ```bash
   sudo docker compose pull
   sudo docker compose up -d
   ```

9. Open the bridge container log, or from SSH: `sudo docker compose logs -f bridge`. Scan the QR (WhatsApp → Linked devices). A log that only repeats `Connection closed (reason: 408)` and never prints a QR means the container WebSocket to WhatsApp is failing. See [No QR, only 408](#no-qr-only-408).
10. On the NAS, over SSH: `curl -sS http://127.0.0.1:37100/health`. `status` stays `disconnected` or `connecting` until the scan finishes. HTTP 200 from `/health` means the process is up, not that WhatsApp is linked.
11. Container Manager → **Volume**. Keep `grok-whatsapp-bridge_wa-session` and `grok-whatsapp-bridge_wa-sessions`. Deleting them deletes the WhatsApp login. Pulling a new image does not.

Older DSM builds may only have the `docker-compose` command (with a hyphen). Use whichever one is installed. A plain Project start does **not** pass `--profile listener`.

## Listener

The listener is off unless you enable the `listener` profile. It calls `http://bridge:37100` on the Compose network (the service name is allowed as `WHATSAPP_TRUSTED_HOSTS`, default `bridge`). That keeps working when the bridge container is recreated. Inbox files live in the `wa-listener` volume (`/app/listener-data`), not in the image. Do not add a public hostname to `WHATSAPP_TRUSTED_HOSTS`.

```bash
sudo docker compose --profile listener pull
sudo docker compose --profile listener up -d
sudo docker compose logs -f listener
```

No `--build`. The listener log should show `bridge=http://bridge:37100`. If the NAS can `curl http://127.0.0.1:37100/health` and the listener still logs `fetch failed`, the host is dropping packets between containers on the project network. Container Manager allows that traffic by default. If the bridge container itself cannot resolve WhatsApp, that is the next section, not a listener bug.

To start the listener from the Container Manager project screen, edit the project YAML and delete the listener service's `profiles:` line. Do not switch the project to a build. The one-shot `pair` service is different: it joins the bridge container's network namespace so it can pause that account on `127.0.0.1`. Run it only while that bridge container is the one currently running.

## Tailscale and SSH

From a laptop, the NAS loopback is not your loopback. Two ways in:

**SSH tunnel**

```bash
ssh -L 37100:127.0.0.1:37100 user@nas
curl -sS http://127.0.0.1:37100/health
```

**Tailscale Serve** (tailnet only), with the Tailscale package or container on the NAS:

```bash
sudo tailscale serve --bg 37100
```

That proxies the tailnet to `http://127.0.0.1:37100`. Do not run `tailscale funnel`. Funnel puts the bridge on the public internet.

If Serve is reached by MagicDNS, the `Host` header is the tailnet name and the bridge returns HTTP 400 until `WHATSAPP_TRUSTED_HOSTS` includes it. See [Tailscale Serve and `WHATSAPP_TRUSTED_HOSTS`](#tailscale-serve-and-whatsapp_trusted_hosts). Prefer an upstream of `127.0.0.1` and, when the proxy preserves `Host`, keep that `Host` as `127.0.0.1` instead of rewriting it to a public or QuickConnect name.

## Host network

Prefer the published `127.0.0.1` mapping. Use host networking when that mapping cannot reach WhatsApp because **Compose bridge-network DNS or egress is dead**.

That failure showed up as `EAI_AGAIN` for `web.whatsapp.com` inside the container while DNS on the NAS host worked, then Baileys close **408** and no QR. It is not fixed by rebuilding the image. It is not an arm/amd64 problem. The NAS is x86_64. The fix that produced a QR was:

- `network_mode: host`
- `WHATSAPP_BIND_HOST=127.0.0.1`
- no `ports:` entry (host mode cannot publish ports)
- still loopback only

Do not set `WHATSAPP_BIND_HOST=0.0.0.0` together with host networking. That listens on every NAS interface, including LAN. Do not publish `0.0.0.0:37100`. Do not use Funnel.

CLI (Compose 2.24 or newer, for `ports: !reset`):

```bash
sudo docker compose -f docker-compose.yml -f docker-compose.host-net.yml pull
sudo docker compose -f docker-compose.yml -f docker-compose.host-net.yml up -d
```

No `--build`. Set `WHATSAPP_TRUSTED_HOSTS` in `.env` when Serve uses MagicDNS.

Container Manager and Portainer usually have one YAML editor and may not support `!reset`. Edit the project YAML:

- Delete the whole `ports:` block. Do not rewrite it as `37100:37100`.
- Under `bridge`, set `network_mode: host` and `WHATSAPP_BIND_HOST: "127.0.0.1"`.
- Under `listener`, set `network_mode: host` and `WHATSAPP_BRIDGE_URL: http://127.0.0.1:37100` (there is no Compose DNS name `bridge` on the host network).
- Leave `pair` on `network_mode: service:bridge` so it joins the bridge container and can pause `127.0.0.1`. Set its `WHATSAPP_BIND_HOST` to `127.0.0.1` as well.

`docker-compose.host-net.yml` is that overlay. It is not merged automatically. `docker-compose.override.yml` is gitignored; do not put host networking there on a dev checkout unless you mean to.

## Linked device name

WhatsApp → Linked devices shows the Baileys browser name. Sessions linked by an older image can still say **Google Chrome (Hermes Agent)**. An image built from the rename says **Google Chrome (Grok WhatsApp Bridge)**. The label usually changes only after that image is the one running **and** the device is linked again. Do not re-pair a working NAS session only to rename the row. Git tag `v1.3.1` is older than the rename, so image `:v1.3.1` built from that tag still has the old label.

## First QR, and a one-shot pair

**First link.** `docker compose up -d`, then `docker compose logs -f bridge`. The running process prints the QR and keeps the session on `wa-session`. You do not need a second container. If that log never prints a QR, see [No QR, only 408](#no-qr-only-408).

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

With the bridge stopped, and the old `session/` directory on the NAS. This copies files into the volume. It does not log the account out and it does not start a new pair by itself.

```bash
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v /volume1/docker/grok-whatsapp-bridge/session:/from:ro \
  bridge -c 'cp -a /from/. /app/session/ && chown -R node:node /app/session'
docker compose up -d bridge
```

Keep the old directory until `/health` shows `connected`. Do not delete `wa-session` to "refresh" a working login.

## Upgrade

Session data is in the volumes, not the image. Pull the new pin. Do not build.

```bash
cd /volume1/docker/grok-whatsapp-bridge
# Edit the image tag in docker-compose.yml (all three services share one anchor).
sudo docker compose pull
sudo docker compose up -d
# if you use the listener:
sudo docker compose --profile listener pull
sudo docker compose --profile listener up -d
```

Do not `docker compose down -v`. Do not delete `wa-session`, `wa-sessions`, or `wa-listener` in Container Manager. Pulling an image does not touch them. Do not `docker compose build`.

`restart: unless-stopped` brings the process back after a reboot or a crash. It does not delete sessions. After an intentional single-account logout the process exits and Docker starts it again until you stop the container and re-pair. Details: [reconnect.md](reconnect.md).

## Health

`/health` returns HTTP 200 while the process is up, including `disconnected`, `connecting`, and the QR wait. The Docker healthcheck uses that on purpose, so a scan or a short 408 does not restart the container. WhatsApp linked is `"status":"connected"` in the JSON. The check calls `http://127.0.0.1:$WHATSAPP_BRIDGE_PORT/health` from inside the container. A first link that never prints a QR is still a healthy process; see [No QR, only 408](#no-qr-only-408).

HTTP 200 from `/health` is not a WhatsApp link. HTTP 200 from `https://web.whatsapp.com` is not a working WebSocket either.

## No QR, only 408

An empty `wa-session` can log `Connection closed (reason: 408). Reconnecting…` and never print `Scan this QR`. That line comes from `account_runtime.js`: the entrypoint and `bridge.js` are already running. Baileys prints the QR only when `connection.update` includes `qr`. **408** (`connectionLost` / `timedOut`, including DNS and timeout errors Baileys maps to 408) means the WebSocket closed before WhatsApp sent a pairing QR. **428** (`connectionClosed`) is the same stage when the socket ends before that QR.

`curl https://web.whatsapp.com` returning HTTP 200 only shows that HTTPS to that host works. Pairing uses a WebSocket, and a filter can allow the HTTPS request while the WebSocket dies. **HTTPS 200 is not WSS.**

On this NAS the bridge network itself has been the break: the container logs `EAI_AGAIN` for `web.whatsapp.com` while the host shell resolves the same name. That is Compose bridge-network DNS/egress, not a generic "something on the firewall" and not a reason to rebuild. Use [Host network](#host-network) (`network_mode: host` and `WHATSAPP_BIND_HOST=127.0.0.1`). Do not `compose --build` in response.

While the log is looping, check the bridge on the NAS:

```bash
curl -sS http://127.0.0.1:37100/health
```

HTTP 200 with `"status":"disconnected"` or `"connecting"` means Node is up and WhatsApp is not linked yet. `"connected"` appears after a successful link. The image healthcheck treats that HTTP 200 as healthy, so this loop does not recreate the container.

Check egress from the **container**, including paths the host shell does not use:

- DNS the container actually uses (Synology Safe Access, AdGuard, Pi-hole, or a VPN resolver). Bridge-network DNS can fail with `EAI_AGAIN` when the host resolver works. Host network skips that path.
- A firewall that allows HTTPS and drops the WebSocket or other long-lived connections to WhatsApp.
- Safe Access, AdGuard, or a VPN whose path the container traffic follows.

Run the same image on a host whose egress already links WhatsApp. That run should print the QR. When it does, leave `wa-session` in place and fix the NAS path. Deleting the volume does not open the WebSocket.

On this failure the bridge adds one line: `Pairing may be stuck — WhatsApp WSS likely failing before QR (check container egress).` Later reconnects keep the usual backoff and do not repeat that line. A later QR clears the latch, so one new pre-QR close can log it again. A 408 after `WhatsApp connected` stays a normal paired reconnect. Details: [reconnect.md](reconnect.md).
