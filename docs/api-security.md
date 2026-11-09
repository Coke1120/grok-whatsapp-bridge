# Authenticated REST API and fail-closed sending

This source update is a **breaking security migration**, not a deployment or
permission to expand a linked account's access. Existing services and paired
sessions are not changed by checking out or reviewing the code.

## Required authentication

Set one deployment-specific `WHATSAPP_API_TOKEN` on the bridge, listener, MCP
HTTP client, and operational tools. Every REST route, including `/health`,
`/messages`, account routes and administrative routes, requires exactly one
`Authorization: Bearer <token>` header. There is no unauthenticated mode or
health exception. Invalid credentials return 401 before route effects or queue
draining. Bridge startup and listener construction reject missing/invalid tokens.
MCP initialization and local inbox reads can work without a token; any HTTP tool
fails before making a request if the token is absent or invalid.

The value must be 32–256 ASCII characters drawn from `A-Z`, `a-z`, `0-9`, `_`,
and `-`. Choose a cryptographically random value at the separately approved
deployment step. Do not use a documentation/test fixture, a phone number, a
webhook token or a hard-coded shared default. This change does not generate,
save or distribute a real credential. Protect `.env` with mode 600 and keep
credentials out of Git, logs, screenshots, resolved Compose output and chat.

Clients do not follow redirects. Operational curl examples feed headers through
stdin rather than putting the token in curl arguments; do not enable shell tracing. The listener sends the API token only to its
configured bridge URL, never as webhook authentication or in webhook payloads.
Configure `WHATSAPP_WAKE_WEBHOOK_AUTH` separately. Protect the bridge URL and
webhook destination configuration as carefully as the token itself.

For local operational commands, export the approved token in the process
environment and use the helper, which keeps it out of command arguments:

```sh
node bridge_http_client.mjs health
node bridge_http_client.mjs pause primary
node bridge_http_client.mjs resume primary
```

The helper returns 0 for HTTP success, 2 only for a definitely refused local
connection, and 1 for authentication/configuration errors, HTTP failures,
redirects or uncertain connectivity. It does not print response bodies or
credentials. `pair.sh`, `logout.sh`, Docker pairing use it. The image healthcheck also uses it; the base Compose
healthcheck uses an authenticated, bounded inline request when a token is
configured, retaining liveness compatibility with the pinned legacy image.
Pairing must stop on status 1: an authentication failure is not evidence that
the bridge is stopped. A refused connection covers only the checked network
namespace; stop any other container/session writer before offline pairing.

## Sending requires an explicit scope

All outgoing chat operations require the account's exact destination in
`WHATSAPP_SCOPES.sendChats`. Missing/empty scopes retain legacy intake/read
behavior but **deny sending**, including text, media, edits, polls, location,
typing and read receipts. Legacy sender/MCP allowlists, read permission, or an
API token never grant send permission. Listener acknowledgements require an
explicit send scope; MCP also retains `WHATSAPP_MCP_SEND_ENABLED=1`.

Read-only operation needs no send destinations. To grant sending, obtain
approval for the account, exact verified JIDs and permitted content, then use
the same or narrower account policy on each client. See [access scopes](access-scopes.md).
An explicit `{}` denies all accounts; `readAllDms` remains a separate opt-in.

## Approved deployment checklist

1. Review and test the source fix. Get separate approval for deployment, token
   creation/storage/distribution, any scope expansion and any live test message.
2. Keep the existing account names, session directories and delivery history.
   Do not delete sessions, re-pair a healthy account or create a second socket.
3. At that approved step, create a fresh token and configure bridge, listener,
   MCP and health/operational clients together. Select explicit send scopes only
   for approved destinations. No insecure compatibility switch is provided.
4. Restart/recreate the existing services in a planned window and reconnect MCP.
   Confirm missing/wrong authentication returns 401, authenticated health works,
   and out-of-scope sends are denied using synthetic/local checks first.
5. Treat 401 as credential/configuration failure, not a reconnect window. Do not
   fall back to unauthenticated calls, start another bridge, delete session files,
   or replay uncertain acknowledgements as a recovery action.

The base Compose pin `ghcr.io/coke1120/grok-whatsapp-bridge:v1.3.3` predates this
fix and does **not** implement authentication or the new health helper. Changing
its environment cannot add these controls. The base Compose healthcheck can
send the token to that old image, but its success does not prove authentication
is enforced. Until an approved release updates the pin, use the reviewed
source with `docker-compose.build.yml` on a development host, or
`docker-compose.mcp.yml` for the local MCP setup. Do not build on a NAS. A NAS
deployment must wait for an approved fixed published image/tag. This PR does
not publish an image, move the release tag or upgrade a live installation.

## Boundary and limits

The token is one **shared bridge credential**, not per-client identity or
per-account authentication. Every holder can use the bridge's administrative
routes and whatever shared read/send ceilings it allows. Giving an MCP process
a narrower policy filters its tools; possession of the same REST token still
permits direct calls within the bridge's wider policy. Use stronger process,
credential and data separation when clients must distrust one another.

Keep loopback binding/publishing, trusted Host validation, tailnet restrictions,
protected files and no public exposure. A token does not make Funnel or an open
internet deployment safe. It does not isolate a hostile host/Docker admin who
can read credentials, edit configuration or access session files.

Reading remains newly observed/cached messages, not a full WhatsApp history
export. Destination restrictions do not prevent a trusted agent from putting
another chat's content into an allowed reply. Content-sharing permission and
untrusted-message handling remain separate controls.
