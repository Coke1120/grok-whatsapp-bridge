# Local Docker MCP and durable webhook wakes

MCP is a local stdio adapter over the existing paired bridge, not a second WhatsApp session or a public server. Docker packaging includes the adapter and an opt-in source-built MCP sidecar with no session mount and no published MCP port. Existing v1.3.3 image pins remain unchanged until a separately authorized release.

The listener persists a credential-free pending wake alongside seen history before network delivery, propagates original message IDs, and supplies a stable account/chat-scoped delivery key. Requests have deadlines and refuse redirects. Failed/blocked events are retained for review. Receiver-side deduplication is necessary for at-least-once retries to be safe, so automatic retry is explicitly off until that receiver behavior is verified; enabling it does not claim exactly-once execution.

We retain legacy API, listener and session compatibility. We do not expand raw REST exposure or pair/restart the user's live account during code verification. Future raw API authentication and a durable upstream receive/ack protocol are separate work: the existing destructive in-memory `/messages` queue is not made lossless by this outbox.
