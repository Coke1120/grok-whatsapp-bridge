# ADR 0003 — GHCR multi-arch image; NAS pulls; host network is a fallback

## Status

Accepted. 2026-10-21.

## Context

Synology Container Manager builds of this image hang (the build PID has to be killed) and `npm ci` fails on the NAS. The NAS is x86_64. The failure is on-box Node install resource limits, not a missing arm build. There is no reliable local Buildx on the NAS. A one-off workaround was a linux/amd64 build on a Mac, then `docker save` / `docker load`. That does not scale, and a multi-arch tarball on a GitHub Release is the wrong artifact.

Separately, Compose bridge-network DNS/egress has died on this NAS: the container gets `EAI_AGAIN` for `web.whatsapp.com` while host DNS works, so Baileys never prints a QR (close 408). Host networking with `WHATSAPP_BIND_HOST=127.0.0.1` produced a QR. Tailscale Serve via MagicDNS can also send a non-loopback `Host` and get HTTP 400 when `WHATSAPP_TRUSTED_HOSTS` is hardcoded to `bridge` and ignores `.env`.

The HTTP API is still unauthenticated. [ADR 0002](0002-docker-loopback-publish.md) stands: loopback publish, no Funnel, sessions on volumes.

## Decision

- GitHub Actions builds `linux/amd64` and `linux/arm64` with Docker Buildx and pushes `ghcr.io/coke1120/grok-whatsapp-bridge`. A published `vX.Y.Z` release or tag pushes `:vX.Y.Z` and `:latest`. `workflow_dispatch` can republish an existing tag whose commit already contains this workflow. No image tarball is attached to GitHub Releases.
- `docker-compose.yml` names that image and has no `build:` key. Synology and Portainer pull the pin. They do not run `compose --build`. `Dockerfile` stays the source of truth. Dev hosts may build with `docker-compose.build.yml`. Bare metal still uses `npm ci`, `./start.sh`, and `./start-listener.sh`.
- The repository is public. Anonymous `docker pull` is the normal path. A later private package would need `docker login ghcr.io` with a classic PAT (`read:packages`). Do not put that token on the NAS while the package is public.
- Operator settings come from Compose interpolation (project `.env`) or the Portainer stack environment. The compose file does not use a relative `env_file`. `WHATSAPP_TRUSTED_HOSTS` defaults to `bridge` and can be extended (MagicDNS). `WHATSAPP_BIND_HOST` stays `0.0.0.0` in the default file so the loopback publish works. `WHATSAPP_SESSION_DIR` inside the container stays `/app/session`.
- `docker-compose.host-net.yml` is opt-in. It sets `network_mode: host`, drops published ports, and sets `WHATSAPP_BIND_HOST=127.0.0.1`. It is the documented response when bridge-network DNS/egress is dead. It is not the default. Host networking must not bind `0.0.0.0` and must not be combined with Funnel or a public port.

## Consequences

- The first tag that contains this workflow and the linked-device rename is `v1.3.2`. The image for that tag is built from git tag `v1.3.2`. Git tag `v1.3.1` does not contain the workflow or the rename. Do not publish `v1.3.1` in place of `v1.3.2`.
- `workflow_dispatch` runs only after this workflow file is on the default branch `main`. Tag and release events use the workflow file in the tagged commit.
- Deleting `wa-session` or `wa-sessions` still logs WhatsApp out. Pulling a new image does not.
- Provenance attestations are off so Container Manager's Docker can pull a plain multi-arch index.
