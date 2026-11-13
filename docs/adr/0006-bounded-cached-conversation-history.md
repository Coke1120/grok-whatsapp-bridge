# 0006: Bounded, scoped conversation history separate from live delivery

Status: proposed with cached-history feature PR; depends on authenticated REST PR #23.

## Decision

Keep a private bounded summary snapshot in each account's existing session
volume. New authenticated reads list cached chats and page retained message
summaries without draining the delivery queue or contacting WhatsApp. Require
explicit read scopes, enforce existing group gates, and filter again at MCP.

Import provider history and append catch-up input directly into this cache. Never
turn it into a webhook, acknowledgement, read receipt, trigger or automatic reply.
Use fixed-size persistent body-free historical/deleted key Bloom filters before
the live queue and cache. They have no eviction/false negatives, while safe false
positives may omit messages/actions as very large histories accumulate. Keep read, trigger and send
permissions independent; do not change live configuration in this PR.

Provide only an explicit, default-off, rate-limited best-effort provider backfill
request with a real cached account/chat anchor. Return request acceptance, never
claim completion. Retain `syncFullHistory: false` and exclude FULL intake. Do not
re-pair, infer JID aliases, fetch media, loop across chats, or auto-retry uncertainty.

## Why

The listener inbox is a delivery log, not a full phone archive, and it omits the
original key/timestamp needed to request older messages. Baileys history responses
are asynchronous and incomplete, and their completion/timestamp conventions are
not reliable enough to promise total recovery. Reusing the live queue would risk
automatic responses to old messages and broaden trigger authority accidentally.

## Consequences

Retained text is private plaintext, bounded by chats, messages and serialized size.
Provider metadata and keys are minimized; attachment/raw cryptographic payloads
are excluded. Scopes are rechecked and purged on restart. Signed cursors reject
changed snapshots rather than silently skipping messages. Cache loss, bounds,
unsupported/ephemeral types and provider behavior all leave gaps. See
[the API and operational caveats](../conversation-history.md) before activation.
