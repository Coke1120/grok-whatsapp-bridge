# v2.0.0: explicit security migration

This is a breaking release. Publishing it does not upgrade the Mac mini, restart
any bridge, create credentials, widen account scopes or request WhatsApp history.

## Image and compatibility

The release publishes `ghcr.io/coke1120/grok-whatsapp-bridge:v2.0.0` for
`linux/amd64` and `linux/arm64`. There are no image tarball release assets.
The publishing workflow now emits only the requested version tag, **not `latest`**.
The existing `latest` digest and base Compose v1.3.3 pin remain unchanged to avoid
silently upgrading existing consumers. Neither is security-fixed: remaining on an
old pin is not a security recommendation. Plan an explicit migration.

Before this release, `latest` resolved to:
`sha256:40f7262b93d4cdea938f4b149648c609488f1d5456e67230d3f63ee5a65ebb0c`.

## Required migration (separately approved deployment only)

1. Read [API security](api-security.md) and [access scopes](access-scopes.md).
   Plan a maintenance window. Preserve existing accounts, paired sessions and
   delivery/history state. Do not delete sessions or re-pair a healthy account.
2. Obtain approval to create/store/distribute a deployment-specific random
   `WHATSAPP_API_TOKEN`. It must be 32–256 characters from `A-Z`, `a-z`, `0-9`,
   `_`, `-`. Configure the same credential on bridge, listener, MCP HTTP clients
   and operational/health tools. Never commit or print it. Webhook auth is separate.
3. Configure explicit account-scoped `sendChats` only for approved destinations.
   Legacy allowlists do not grant sending. Read scopes, automatic triggers and
   send permission remain independent. Missing/empty send scope denies outgoing
   actions; history requires explicit read scopes.
4. At the approved deployment step, update the shared `bridge-image` anchor in
   Compose from v1.3.3 to v2.0.0 (bridge/listener/pair together), or use the reviewed
   source workflow for the Mac mini. This release itself makes no such deployment.
   Keep loopback publishing, existing volume mounts and the MCP source overlay's
   separate build requirements. Do not build on the NAS.
5. Restart only during that approved window. New bridge/listener startup rejects
   absent/invalid tokens; all REST routes including `/health` require Bearer auth.
   Old unauthenticated clients receive 401. Do not treat 401 as an offline bridge,
   bypass auth, launch another session writer or reset pairing.
6. Validate configuration and denied requests using synthetic/local checks first.
   Sending a real message, expanding read scope or enabling provider backfill
   requires separate approval. Both history-backfill switches remain off by default.

The history feature is a bounded local plaintext text/metadata cache, not a full
phone archive. See [history limitations](conversation-history.md). Attachments and
recognized disappearing/view-once content are excluded. No live-account validation
or complete provider-history coverage is claimed.
