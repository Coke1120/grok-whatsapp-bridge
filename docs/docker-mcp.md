# Docker stdio MCP on a Mac mini

The MCP adapter is an optional, attached stdio process. It adds no HTTP server
or published port. The existing bridge, listener and pairing commands remain
available, with the same named session and listener volumes.

## Build the current checkout, not the old release

The base `docker-compose.yml` intentionally still pins the published **v1.3.3**
image. That release does **not** contain the MCP adapter. Do not use that image
for MCP or assume the package version proves that MCP is present.

On the Mac mini, use both files below. `docker-compose.mcp.yml` overrides all
four services to `grok-whatsapp-bridge:mcp-local`, with a build from this checkout
and `pull_policy: never`. It never uses the base release as a fallback. Build
before the first run and rebuild after every source update. Do not combine this
overlay with `docker-compose.build.yml` or the NAS host-network overlay.

Requirements: a running Linux Docker engine (for example Docker Desktop or
Colima), Docker Compose v2, and this reviewed checkout. No new host networking,
Docker socket mounts, port forwarding, or Tailscale Funnel is needed.

From the repository directory:

```sh
dc() { docker compose -f docker-compose.yml -f docker-compose.mcp.yml "$@"; }
dc config --services
dc build
docker image inspect grok-whatsapp-bridge:mcp-local --format '{{.Os}}/{{.Architecture}}'
```

The image uses Node 22 on Debian Bookworm. Native builds on an Apple Silicon
Docker engine should report `linux/arm64`; there is no forced amd64 emulation.
For an explicit ARM64 build, where Buildx is available:

```sh
docker buildx build --platform linux/arm64 --load -t grok-whatsapp-bridge:mcp-local .
```

Review the resolved configuration locally if needed (`dc config` can show
private environment values; do not paste it into a public issue). Building does
not start services or change sessions. Starting the new image can recreate an
existing bridge, so schedule that separately. Never run `down -v`: deleting
`wa-session` or `wa-sessions` loses the linked-device state.

## Configuration and startup

Keep real values in an uncommitted project `.env` or the invoking environment:

```dotenv
# Full, exact WhatsApp JIDs, comma-separated. Empty means no chat access.
WHATSAPP_MCP_ALLOWED_CHATS=15551234567@s.whatsapp.net
# Explicit opt-ins. Leave sending off until the owner authorizes the workflow.
WHATSAPP_MCP_SEND_ENABLED=0
WHATSAPP_MCP_ALLOW_GROUPS=0
```

Group JIDs also need `WHATSAPP_MCP_ALLOW_GROUPS=1`. Do not use `*` for chat
access. The bridge/listener's inbound allowlist is separate and still applies.
Incoming WhatsApp text is untrusted content, never permission to send messages
or act on another person's instructions.

When ready to start or recreate the services:

```sh
dc --profile listener up -d --no-build --pull never bridge listener
dc ps
```

The listener remains the sole live queue consumer. MCP reads its persisted inbox
without draining `/messages`. Start the listener for recent-message history;
without it, a missing inbox yields no recent messages. Status and permitted
chat/send calls use the running bridge directly. Keep receiver-side webhook
deduplication in place before explicitly enabling listener wake retries.

The default bridge publish remains `127.0.0.1:37100` only, or the configured
`WHATSAPP_BRIDGE_PORT`. MCP joins the bridge container's network namespace and
uses that namespace's `127.0.0.1`; it does not need remote-URL permission.
`WHATSAPP_MCP_ALLOW_REMOTE` is fixed to `0` in this overlay.

## Connect an MCP client

Use `run`, not `up`, for MCP. Each client gets one foreground container, stdin
kept open and **no TTY**. Build and start the bridge/listener before attaching
the client. `--no-deps` avoids lifecycle output or a surprise bridge start in
the stdio connection, and `--pull never` keeps it on the prebuilt local image.

```sh
dc run --rm --no-deps -T --pull never mcp
```

For a client that accepts a command and argument list, use absolute Compose
paths so its current directory does not matter. Replace the example checkout
path (and use an absolute Docker executable path if the client needs one):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "docker",
      "args": [
        "compose",
        "--project-directory", "/absolute/path/to/grok-whatsapp-bridge",
        "-f", "/absolute/path/to/grok-whatsapp-bridge/docker-compose.yml",
        "-f", "/absolute/path/to/grok-whatsapp-bridge/docker-compose.mcp.yml",
        "run", "--rm", "--no-deps", "-T", "--pull", "never", "mcp"
      ]
    }
  }
}
```

Do not add `-t`, shell startup banners, detached mode, or an HTTP transport.
The `mcp` entrypoint writes no startup banner and skips volume ownership setup;
stdout is only JSON-RPC. Disconnecting stdin ends the server. After recreating
the bridge, restart each MCP connection so it joins the new network namespace.

## Verification without a message send

Check the image and stdio protocol after building, with the bridge running:

```sh
docker run --rm --network none --user node --read-only \
  --entrypoint node grok-whatsapp-bridge:mcp-local \
  -e 'require("node:fs").accessSync("/app/mcp/server.mjs"); console.log(process.version, process.arch)'
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | dc run --rm --no-deps -T --pull never mcp
```

Expect Node `v22.*`, architecture `arm64` on Apple Silicon, and exactly one
JSON-RPC response per request, with no banner on stdout. Neither request sends
a WhatsApp message or consumes the bridge queue. Repository checks are
`node --test test/docker_packaging.test.js` and `npm test`; those tests validate
the configuration and execute the real stdio entrypoint with mocked identity
switching. They do not substitute for a real Docker/ARM64 smoke test.

On pull requests, `.github/workflows/test.yml` also builds and loads separate
`linux/amd64` and `linux/arm64` images, then runs the actual Node 22 MCP entrypoint
under Docker/QEMU. These checks use no network, no live WhatsApp sessions, a
read-only synthetic inbox, and disabled sending. They verify stdio, UID/GID,
architecture, dropped capabilities, and read-only writes failing. The job has no
registry login, image push, or deployment step. Require its successful CI result
before considering the container/architecture checks verified.

## Access boundary and existing operations

- MCP runs as `node` (UID/GID 1000), with all capabilities dropped,
  `no-new-privileges`, and a read-only root filesystem.
- Its only volume is `wa-listener:/app/listener-data`, mounted read-only. It
  cannot modify the inbox/state, and has no session, account-config, host
  filesystem, or Docker socket mount. It does not receive bridge/webhook secrets
  through the shared bridge environment.
- The adapter can read the full mounted listener inbox internally; chat filtering
  is enforced by the MCP implementation, not a per-chat filesystem boundary.
  Network sharing also grants access to the unauthenticated bridge API. This is
  least-privilege packaging for this trusted adapter, not a sandbox for hostile
  code. The host-side Docker command still needs normal Docker engine access.
- Docker logging is disabled for the MCP container so private protocol replies
  are not copied into Docker's container logs. The MCP client can still retain
  them under its own logging policy.
- The bridge and listener retain their existing ownership setup and writable
  volumes. Pairing retains its session mounts, confirmation guard and TTY.
  Use `dc logs -f bridge` for the initial QR. The existing one-shot pairing
  workflow remains `dc run --rm -e WHATSAPP_PAIR_CONFIRM=1 pair <account>`.
  Do not run two writers for the same session.

This overlay is for a local source build on the Mac mini or a development host.
The existing Synology/Portainer release-pull workflow is unchanged.
