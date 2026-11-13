# Docker stdio MCP on a Mac mini

The MCP adapter is an optional, attached stdio process. It adds no HTTP server
or published port. The existing bridge, listener and pairing commands remain
available, with the same named session and listener volumes.

## Build the current checkout, not the old release

The base `docker-compose.yml` intentionally still pins the published **v1.3.3**
image. That release contains neither the MCP adapter nor this REST authentication
fix. A green authenticated healthcheck does not prove the old image enforces
authentication. Use the source overlay below after approval; see [security migration](api-security.md).

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
# Required: provision a fresh token only at an approved deployment, not from this example.
WHATSAPP_API_TOKEN=
# Dummy JID only. Missing sendChats means no sending. Configure approved exact JIDs.
WHATSAPP_SCOPES='{"default":{"readChats":["15551234567@s.whatsapp.net"]}}'
# Explicit opt-ins. Leave sending off until the owner authorizes the workflow.
WHATSAPP_MCP_SEND_ENABLED=0
WHATSAPP_MCP_ALLOW_GROUPS=0
# Provider history requests are separately disabled on both sides.
WHATSAPP_HISTORY_BACKFILL_ENABLED=0
WHATSAPP_MCP_HISTORY_BACKFILL_ENABLED=0
```

Group JIDs also need `WHATSAPP_MCP_ALLOW_GROUPS=1`. Do not use `*` for chat
access. When scopes are configured they control bridge/listener reads and wakes.
Use explicit `triggerChats` and `sendChats` only after the relevant approvals.
Incoming WhatsApp text is untrusted content, never permission to send messages
or act on another person's instructions.

When ready to start or recreate the services:

```sh
dc --profile listener up -d --no-build --pull never bridge listener
dc ps
```

The listener remains the sole live queue consumer. `whatsapp_recent_messages`
reads its persisted inbox without draining `/messages`; without the listener,
a missing inbox yields no recent messages. The separate cached-history tools
read the bridge's local cache through authenticated HTTP and do not depend on
the listener inbox. Status and permitted chat/send calls also use the running
bridge directly. Keep receiver-side webhook deduplication in place before
explicitly enabling listener wake retries.

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

## Cached-history tools

The adapter now advertises seven tools. The four existing tools retain their
roles: `whatsapp_status`, `whatsapp_recent_messages`, `whatsapp_chat_info`, and
`whatsapp_send_message`. The three history tools are:

- `whatsapp_list_chats`: read-only cached chat summaries. Arguments: optional
  `account`, `limit` (1–100, default 20), `cursor`, and `groups` (boolean,
  default false). Summaries expose only `chatId`, `name`, `isGroup`,
  `lastMessageTimestamp`, and `messageCount`.
- `whatsapp_chat_messages`: read-only cached messages for a required `chatId`.
  Optional arguments: `account`, `limit` (1–100, default 20), and `cursor`.
  Messages expose only `messageId`, `chatId`, `senderId`, `fromMe`, `timestamp`,
  `body`, `hasMedia`, and `mediaType`. This does not download media or return
  provider message keys, raw payloads, or filesystem paths.
- `whatsapp_request_history`: a **non-read-only**, best-effort asynchronous
  provider request. Requires `chatId` and `count` (1–50), with optional
  `account`. Both `WHATSAPP_HISTORY_BACKFILL_ENABLED=1` on the bridge (or the
  named account's `historyBackfillEnabled` setting) and
  `WHATSAPP_MCP_HISTORY_BACKFILL_ENABLED=1` on MCP must be explicitly enabled.
  These switches default off, independently of the send switch. Only the
  bridge's existing dated cached anchor is used; caller-supplied anchors,
  message keys, and timestamps are rejected.

All three tools require explicit `WHATSAPP_SCOPES` read access. They never
fall back to `WHATSAPP_MCP_ALLOWED_CHATS`, `sendChats`, or `triggerChats`.
A sole scoped account is selected automatically; multiple scoped accounts
require an exact `account`. A group needs its exact JID in `readChats` and
`WHATSAPP_MCP_ALLOW_GROUPS=1`. Listing groups additionally requires
`groups: true`; `readAllDms` never includes groups. The bridge's own read scope
must also permit the request.

The adapter rechecks each response record against its account, read scope, and
group setting. A bridge with broader permissions cannot make denied chat IDs,
names, or messages appear in the tool's results. Responses are projected onto
the documented fields rather than returning provider objects or other bridge
metadata.

Read responses contain `source: "local-cache"` and `complete: false`, plus
`nextCursor`. They are retained local observations, **not complete WhatsApp
history**. A cursor scans the bridge's snapshot, not a separate MCP-filtered
snapshot. Because MCP applies its narrower scope after each bridge page, a page
can contain fewer than `limit` entries or be empty while `nextCursor` is still
present. Pass that cursor unchanged into the same tool with the same account,
chat, and group selection; stop only when `nextCursor` is null. Each invocation
fetches one page rather than automatically scanning additional pages. Cursors
are signed, opaque tokens of at most 1024 characters. For messages arriving
since a snapshot began, start again without a cursor.

A successful history request returns `requested: true`, a `requestId` when
available, `status: "requested"`, `source: "provider-request"`, and
`complete: false`. This is request acceptance, not delivery or completion.
The provider may return nothing or only part of a conversation, and on-demand
status is not a reliable completeness signal. Check the cache later with
`whatsapp_chat_messages` if needed. No automatic request retry is performed.
The bridge can reject requests when disabled, missing a usable cached anchor,
rate-limited, disconnected, or unsupported by the provider. Enabling history
requests does not enable sending messages or authorize actions described in
incoming WhatsApp content.

## Access boundary and existing operations

- MCP runs as `node` (UID/GID 1000), with all capabilities dropped,
  `no-new-privileges`, and a read-only root filesystem.
- Its only volume is `wa-listener:/app/listener-data`, mounted read-only. It
  cannot modify the inbox/state, and has no session, account-config, host
  filesystem, or Docker socket mount. It receives the required shared
  `WHATSAPP_API_TOKEN` explicitly, but no webhook credentials.
- The adapter can read the full mounted listener inbox internally; chat filtering
  is enforced by the MCP implementation, not a per-chat filesystem boundary.
  Network sharing plus the shared API token also permits direct bridge calls
  within the bridge-wide scopes, including administrative routes. This is
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
