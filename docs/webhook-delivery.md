# Durable listener webhook delivery

## Scope and identity

The single listener still drains the bridge `/messages` queue. Each observed event now carries its original `messageId` into `inbox.jsonl`, the webhook and the MCP recent-message tool. If upstream has no ID, `messageId` is null; no WhatsApp ID is invented. A separate `deliveryId` hashes account, chat and upstream ID (or the full legacy event fallback). The same delivery has the same ID across retries and restarts. Distinct chats/accounts do not collide merely because their WhatsApp IDs are equal.

The webhook includes `deliveryId` and sends the same value as `Idempotency-Key`. The receiver **must store this key durably and reject duplicates before starting an agent action**. A header is not proof of OpenMausBot receiver support. Do not enable autonomous retry until this behavior has been verified. In particular, a repeated event must not cause another WhatsApp reply or another computer operation.

## Commit and delivery ordering

The listener records the entire drained batch before awaiting outbound acknowledgement or wake requests. For each event it appends an inbox row, then atomically saves seen history and the pending wake payload in `listener-state.json`, fsyncs it and renames it before transmitting. In-flight status and attempt count are also committed before a request. The state contains private message data but no webhook URL or bearer token. It binds pending deliveries to a hash of the configured account destination and credentials; changes block old deliveries instead of redirecting them. The current inbound allowlist is rechecked before delivery.

Keep the listener state and inbox in a persistent private volume; run exactly one listener. A malformed/unreadable state fails closed rather than silently resetting duplicate history. The state file is created with mode 0600. Do not commit it, its temporary files, inbox data or sessions. Do not delete state to fix a delivery error.

This is **not end-to-end exactly-once delivery**. The upstream `/messages` queue is in memory and destructive: a bridge crash or listener crash before a drained batch is persisted can still lose events. A crash between inbox append and state commit can duplicate a log row. The on-disk seen cache retains 500 recent IDs (the current process also retains its history); much older upstream repeats outside that cache are not guaranteed deduplicated. Pending outbox IDs remain protected until resolved.

## Retry and failure behavior

- Every wake has a request deadline, default five seconds (`WHATSAPP_WAKE_TIMEOUT_MS`, range 50–30000).
- Redirects are refused so a webhook URL cannot forward credentials or private message data elsewhere.
- Successful 2xx delivery removes the pending payload; it does not prove the agent completed its work.
- Automatic retries default **off**, preserving compatibility and avoiding blind replay when delivery is uncertain. A network error, timeout or recoverable HTTP failure is retained as `needs_review`.
- Set `WHATSAPP_WAKE_RETRY_ENABLED=1` only after receiver idempotence is verified. Transient network errors, timeouts, HTTP 408/425/429 and 5xx use bounded retries with the same payload/key. Turning retries off stops pending retries.
- Default maximum is five total attempts (`WHATSAPP_WAKE_MAX_ATTEMPTS`, range 1–10). Backoff is 5 seconds, 30 seconds, 2 minutes, then 10 minutes; events expire after one hour. A restart does not reset attempts or event age.
- Other HTTP failures (including authentication errors and redirects) are not retried. Expired/exhausted entries remain `failed`. Configuration/allowlist changes retain `blocked` entries. In-flight entries after a crash need review unless retry is explicitly enabled.
- No response body, raw URL or token is logged. Logs identify the delivery ID and safe failure code.
- At 500 unresolved wake entries or uncertain acknowledgement tombstones intake pauses before the next destructive poll. A batch already drained is retained in full, so this threshold can be exceeded by that last batch. Resolve failures before resuming; never silently drop them to make space.
- At most ten due wakes are attempted per pass, without concurrent delivery. The legacy fixed acknowledgement is separate. Uncertain acknowledgement IDs remain durable outside the bounded seen cache, so cache eviction or restart cannot resend them automatically. Bridge polling also has a deadline, so an unresponsive bridge cannot hold the delivery loop forever.

Failed events are not automatically replayed when configuration is repaired. First determine whether the receiver already accepted them, check the delivery ID in receiver receipts, and obtain approval for any consequential replay. There is currently no automatic replay CLI or HTTP endpoint. Preserve files for local diagnosis without uploading them.

## Acceptance before broad use

Use a permitted test chat and a local test receiver. Confirm IDs survive inbox/webhook/MCP, retry after a controlled 503, suppress duplicates before actions, preserve state through restart, reject a removed allowlist, and record a timeout as uncertain. Then verify the real OpenMausBot automation receipts and same-chat response with explicit sending permission. Repository tests use fake/local receivers and do not prove production OpenMausBot deduplication or live WhatsApp delivery.
