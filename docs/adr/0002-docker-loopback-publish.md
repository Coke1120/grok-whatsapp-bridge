# ADR 0002 — Docker publishes loopback; sessions stay on volumes

## Status

Accepted. 2026-10-21.

## Context

`bridge.js` listens on `127.0.0.1` and rejects any HTTP `Host` that is not a loopback name. Docker bridge networking delivers a published port to the container's eth0, not to its loopback, so a process bound only to `127.0.0.1` inside the container is unreachable from the host mapping. Session files must survive image rebuilds. The HTTP API has no authentication, so the port must not be reachable from the public internet.

## Decision

- Compose publishes `127.0.0.1:${WHATSAPP_BRIDGE_PORT}:${WHATSAPP_BRIDGE_PORT}` only.
- The image sets `WHATSAPP_BIND_HOST=0.0.0.0`. Allowed values are `127.0.0.1`, `::1`, `0.0.0.0`, and `::`. Unset still means `127.0.0.1`, which is what `./start.sh` keeps doing.
- The Host allowlist stays loopback, plus an explicit `WHATSAPP_TRUSTED_HOSTS` list. Compose sets that to the service name `bridge` so the listener can call `http://bridge:37100`. A public hostname is not added. Callers on the NAS still use `http://127.0.0.1:37100`, an SSH tunnel, or Tailscale Serve aimed at that loopback address. Tailscale Funnel and a public port publish are out of scope.
- Named volumes `wa-session` (`/app/session`) and `wa-sessions` (`/app/sessions/<name>`) hold Baileys state. The entrypoint chowns them to the `node` user and drops root with `setpriv`.
- The optional listener is a Compose profile on the project network, not started by a plain `up`. It uses the `bridge` DNS name so a bridge recreate does not leave it stuck in the old network namespace. The one-shot `pair` service does share the bridge network namespace, because it has to pause the live socket on `127.0.0.1`.
- The container healthcheck is "GET /health returns HTTP 200". It stays healthy while WhatsApp is `connecting` or waiting for a QR. `restart: unless-stopped` is the outer process restart. It must not delete volumes.

## Consequences

- Host networking plus `WHATSAPP_BIND_HOST=0.0.0.0` listens on every interface of the NAS. Host networking has to set `WHATSAPP_BIND_HOST=127.0.0.1` and drop the `ports:` mapping.
- `docker compose down -v`, or deleting `wa-session` / `wa-sessions` in Container Manager, logs the WhatsApp account out on the next start.
- A proxy that forwards a public `Host` header receives HTTP 400. Point it at `127.0.0.1` and leave the upstream Host as that loopback name.
