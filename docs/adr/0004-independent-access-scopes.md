# ADR 0004 — Separate reading, automatic triggers and outgoing destinations

> Historical context: [ADR 0005](0005-authenticated-rest-boundary.md) supersedes the unauthenticated REST and legacy-send exceptions below. Current source requires a token and explicit send scopes.
## Status

Accepted for implementation. Activation and broader account access require the
owner's separate approval. Existing deployments are not changed automatically.

## Context

The original sender allowlist controlled intake and agent wakes together. MCP
used the same chat list for reads and sends. Expanding read access could therefore
expand reply destinations, while direct REST sends bypassed the MCP list. A chat
JID alone also did not distinguish two linked accounts' inbox rows.

## Decision

Add one optional, explicit `WHATSAPP_SCOPES` JSON map keyed by account name. Each
policy has independent `readAllDms`, `readChats`, `triggerChats` and `sendChats`.
Missing accounts and fields deny access. Only the explicit `readAllDms: true`
flag broadens private reading; wildcards never grant sending or triggering.

The runtime checks reads before extraction/download/cache, and outgoing
destinations before file access or socket side effects. The listener rechecks
read access before logging bodies and separately checks automatic triggers.
MCP checks account + chat, filters inbox rows before applying the result limit,
and checks current permissions even for older cached messages.

Automatic triggers support incoming private message events only. Own messages,
groups, poll-vote aggregations and legacy queued events without provenance do
not trigger in scoped mode. An aggregated poll has no safe single voter to
authorize, so it may be read when the chat is permitted but never wakes an agent.
Pending wakes are revalidated against current read/trigger policy before delivery.

Unset/empty policy retains legacy behavior for compatibility. Explicit `{}` is
strict deny-all. The same account-qualified policy must be configured on bridge,
listener and MCP; an individual adapter may have a narrower policy.

## Limits

The local REST API remains an unauthenticated control plane for trusted local
processes. Scope gates are shared ceilings, not client authentication or a
machine-wide sandbox. Protect the host, session files and Docker access. A
process-killing fault still affects every account in the process.

Read-all is new observed DM text, not a WhatsApp history export or attachment
download. Send-destination limits cannot prevent an agent from leaking something
it can read to an allowed recipient. Content-sharing approval and tool isolation
remain necessary; do not give an untrusted agent host-file or raw-control access.
