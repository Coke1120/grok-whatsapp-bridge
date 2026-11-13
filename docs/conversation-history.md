# Cached conversations and partial message history

This feature ships in v2.0.0, built on the authenticated REST boundary in PR #23.
See the [explicit migration guide](release-v2.0.0.md).
It is not present in the published v1.3.3 image. Merging this PR does not deploy it,
change an access policy, initiate backfill, re-pair a phone or publish a release.

## Read access remains independent

All new operations require the API Bearer token and an explicit account policy in
`WHATSAPP_SCOPES`. Legacy allowlists alone cannot enable history. The account's
`readChats` / `readAllDms` ceiling applies before storing chat metadata or message
summaries, while loading saved data, and again on every page and backfill request.
Groups also require the bridge's existing group policy/pairing checks. MCP has its
own narrower scope and additionally requires `WHATSAPP_MCP_ALLOW_GROUPS=1` for groups.
No PN/LID alias inference, cross-account fallback, wildcard send permission or
trigger permission is introduced.

A broad read grant does not change `triggerChats` or `sendChats`. They can remain
restricted to the one approved private contact. New history/append data never
enters the live queue, listener webhook, programmatic acknowledgement, read receipt,
typing or send paths. A historical key replayed as a notify event is also not queued, even if its
content was excluded or its summary was evicted. Cached live rows also suppress
repeat notifications while retained. Append events no longer cause automatic actions in legacy intake mode.

## What is saved

Each explicitly scoped account keeps `conversation-history.json` inside its own
session directory. The snapshot uses atomic replacement and mode 0600. It is
private plaintext, not encryption or isolation from a host administrator. Protect
session volumes and backups accordingly. Do not commit or upload it.

The cache holds at most 256 conversations, 2,000 message summaries overall and 500
per conversation, with a 12 MiB serialized limit. Oldest summaries are evicted when
necessary. Bodies are limited to 4,096 characters and names to 256. A summary has
an ID, exact chat ID, sender ID, fromMe flag, original provider timestamp (seconds
in ordinary Baileys messages), text/caption, and media type/presence. Provider
message keys are saved privately only as possible backfill anchors and are not
returned by the read API. Missing timestamps remain zero, never fabricated.

Two fixed-size, persistent body-free Bloom filters retain historical and revoked
account/chat/message fingerprints independently of summary eviction (1 MiB and
128 KiB before base64 encoding). They never forget a marked key: hash collisions
can only omit a new message or automatic action, never reveal revoked content or
re-trigger history. False positives increase if very large numbers of distinct
historical/deleted keys accumulate; this is another reason not to treat the cache
as an authoritative archive. Removing/resetting the file also resets this guard
and must be an owner-reviewed maintenance action, not an automatic recovery.

No attachments, thumbnails, download URLs, raw protobufs, cryptographic material,
quoted message contents, location/contact payloads or host-file paths are archived.
Recognized view-once and disappearing-message envelopes/context are excluded.
Unsupported message types are omitted. Observed deletion and REVOKE updates remove cached summaries and mark the
key to prevent later history from resurrecting it, but this is a bounded cache, not a complete or compliance-grade archive.
History updates that could not be persisted log a generic warning; storage must be
writable for durable retention. A storage failure can also lose newly marked
replay/revocation protection after a restart; resolve storage errors before
resuming automatic actions. No recovery across lost/failed storage is guaranteed.
Pause/logout does not erase the saved cache.

Startup rechecks scopes and rewrites the file to purge now-denied cached
summaries and names. Body-free account-wide replay fingerprints remain because
Bloom bits cannot be removed selectively; every operation still checks current
scope before using a key. A
malformed, oversized, symlinked or wrong-account cache fails closed. Pair-only and
legacy unscoped runtimes do not create an archive.

The cache learns from authorized provider history/chat events, live messages,
append catch-up events and readable outgoing message responses. It starts empty;
there is no migration of listener inbox files or import of another account's data.
Conversation names are provider-supplied cached metadata and are not a complete
address book. Cached reads work while disconnected and do not consume the queue.

## REST operations

Use the existing authenticated client with `Authorization: Bearer ...`. Account
selection works through `/accounts/<name>/...`, the existing account header, or
query selector; conflicting selectors are rejected. Examples below omit credentials.

- `GET /accounts/default/chats?limit=20&groups=0`
- `GET /accounts/default/chat/<encoded-exact-jid>/messages?limit=20`
- Add `cursor=<url-encoded-nextCursor>` to request the next page.

Responses contain `source: "local-cache"`, `complete: false`, `truncated`, and
`nextCursor` (null when there is no next **cached** page). Chat pages contain
`chats`; message pages contain `chatId` and `messages`. Limits are 1..100, default
20. Messages sort newest-first by provider timestamp, then ID. Chats sort by newest
cached message timestamp, then exact chat ID. A chat without saved messages has
lastMessageTimestamp 0. Counts describe retained messages, not provider totals.

Cursors are signed, opaque, account/query-bound and contain no message text.
They are invalid after restart; invalid/cross-account/cross-chat/query cursors return
400. A cache mutation invalidates an existing pagination snapshot with 409. Restart
pagination rather than silently skipping or duplicating entries. Do not decode or
construct cursors. A null cursor does not prove that the phone has no older history.

## Optional best-effort provider request

Backfill is a separate network action, never an automatic side effect of GET or
listing. Leave `WHATSAPP_HISTORY_BACKFILL_ENABLED=0` unless the owner separately
approves contacting the linked phone for history. Multi-account config can override
it with per-account `historyBackfillEnabled`; `accounts/*.env` supports the same env
key. MCP also defaults `WHATSAPP_MCP_HISTORY_BACKFILL_ENABLED=0` and requires both
switches plus its own read scope. It does not require ordinary send or trigger
permission because it sends a provider protocol request to the account's own device,
not a chat message.

With approval and both service/config switches appropriately enabled:

`POST /accounts/default/chat/<encoded-exact-jid>/history` with JSON `{"count":20}`.
Only count is accepted (1..50, default 20). The server selects the oldest retained
message with a real provider timestamp and exact key for that account/chat. No
caller-supplied anchor, synthetic timestamp, alias or fresh pairing is accepted.
No cached dated anchor returns 409. Disabled/out-of-scope requests return 403;
unavailable/disconnected provider support returns 503. Requests are serialized and
limited to one per account per 60 seconds. If a provider promise never settles,
the account remains single-flight even after the HTTP response times out; it does
not admit another provider request merely because the cooldown elapsed. There is no loop over conversations.

202 with `requested: true`, `status: "requested"`, a request ID and `complete: false`
means the protocol request was accepted, **not** that messages arrived or that the
history is complete. Results may arrive later through `messaging-history.set` and
are independently filtered into the cache. We do not attribute a whole provider
batch to one request or use `isLatest`, progress, or an empty page as proof of
completion. Provider rejection/timeout/connection replacement returns 503 with an
uncertain-outcome warning; the cache may still update later. Never retry
backfill automatically after uncertainty.

`syncFullHistory` remains false and FULL-sync intake remains excluded. Reconnection
of an already linked device cannot be relied on to recover older phone history.
The provider may return only part, nothing, delayed data or duplicates; no complete
phone-history or attachment recovery is promised. This PR's verification is based
on pinned source and synthetic fixtures, not a real-account backfill.

### Pinned Baileys contract and timestamp caveat

The project pins Baileys 7.0.0-rc13. Its
[`fetchMessageHistory(count, key, timestamp)`](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc13/src/Socket/messages-recv.ts#L164-L185)
returns a request ID; messages arrive asynchronously. ON_DEMAND sync does not have
a reliable completion indicator in the pinned implementation. This adapter follows
the [pinned official example](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc13/Example/example.ts#L147-L150)
and passes the original provider `messageTimestamp` unchanged, despite the wire
field name `oldestMsgTimestampMs`. Upstream reports disagree about conversion;
this convention is not presented as live-verified. Validate separately with the
owner's approval before enabling it on a real linked account.
