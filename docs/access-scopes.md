# Independent read, trigger and send permissions

This is an **opt-in** feature. Installing its code does not expand a live linked
device's data access, restart services, pair another account, or authorize sends.

## Policy

Set `WHATSAPP_SCOPES` on **bridge, listener and MCP**. It is a JSON object keyed by
the exact account names in the account configuration. An unchanged single-session
installation uses `default`.

```dotenv
# Dummy identity only. Use a provider-verified exact received JID, not a guessed LID.
WHATSAPP_SCOPES='{"default":{"readAllDms":true,"readChats":[],"triggerChats":["15550000001@lid"],"sendChats":["15550000001@lid"]}}'
WHATSAPP_MODE=bot
WHATSAPP_GROUP_POLICY=disabled
WHATSAPP_FORWARD_OWNER_MESSAGES=0
WHATSAPP_SEND_READ_RECEIPTS=0
WHATSAPP_PROGRAMMATIC_ACK=
WHATSAPP_MCP_SEND_ENABLED=1
WHATSAPP_MCP_ALLOW_GROUPS=0
```

- `readAllDms: true`: cache/read newly observed private DMs from all contacts on
  this account, including contacts not yet listed. It excludes groups, broadcasts
  and status updates. Omit it, or use `false`, for explicit `readChats` only.
- `readChats`: exact full WhatsApp chat JIDs that may be read. `@lid` and
  `@s.whatsapp.net` are distinct; these permissions do not guess or rewrite them.
- `triggerChats`: exact **private** chat JIDs that may automatically wake an
  agent. The conversation must also be readable. Group triggers are rejected.
  Own/echo messages and poll-vote updates never trigger in scoped mode.
- `sendChats`: exact destinations permitted for outgoing operations, independent
  of read membership. Empty means no outgoing destinations. MCP still requires
  `WHATSAPP_MCP_SEND_ENABLED=1` for sending.

Missing fields are empty/false. Missing account policies deny that account.
Explicit `{}` denies all accounts. Unset or empty `WHATSAPP_SCOPES` preserves
legacy behavior, including the older unauthenticated REST send behavior. JSON
`null`, unknown fields, non-boolean flags, malformed JIDs and wildcards are errors.
Do not use `WHATSAPP_ALLOWED_USERS=*` as a substitute for this policy.

In scoped mode `WHATSAPP_ALLOWED_USERS` no longer controls DM reading or wakes;
the independent policy is authoritative. Existing self-chat/owner forwarding and
group intake settings remain additional restrictions. For group reads, both an
explicit `readChats` entry and the existing group intake policy must allow it;
MCP additionally requires its group opt-in. `readAllDms` never includes groups.

## Accounts and MCP

Each policy belongs to one exact account. No account inherits another's policy.
For example, `primary` can read all its DMs while an omitted `sales` account is
denied. Keep the existing primary session directory; never copy credentials or
run another socket against the same directory.

In scoped mode MCP status/chat/send use explicit account routes. With one policy
account, omitted `account` selects it. With multiple policy accounts, specify
`account` on every tool call, including `whatsapp_recent_messages`. Unknown
accounts fail before a bridge request. Inbox records must match the selected
account. Historical records without an account are readable only under the
literal `default` policy, never assigned to another named account.

The recent-message tool reads up to 20 matching messages from the final 512 KiB
of the private inbox. It is not a complete history API or contact directory.
Tightening a current read scope also hides older cached rows outside that scope.
Attachments are represented by text/metadata in scoped mode and are not
automatically downloaded. Owner-authored messages still need the separate
`WHATSAPP_FORWARD_OWNER_MESSAGES` opt-in and never wake an agent.

For different agents, give each MCP process only its own account policy subset.
This is application filtering, not OS isolation of a shared inbox. Use separate
protected processes/inboxes when that stronger boundary is required.

## Automatic replies

The single listener remains the only consumer of the destructive `/messages`
queue. Readable but non-triggering messages are cached with `readAllowed: true`
and `allowed: false`; they do not wake, acknowledge, or set the unread-trigger
flag. A trigger can wake a read-only agent without granting send permission.
Fixed acknowledgements additionally require the destination's send permission.

New scoped events carry `scopeVersion`, `eventType` and `fromOwner` provenance.
Legacy pending deliveries without these fields do not become automatic triggers
on migration. Existing seen/outbox records are preserved, not replayed or reset.
Current read/trigger/account policy and webhook destination are rechecked before
each pending wake. Keep automatic retries disabled until receiver deduplication
has been verified. A timeout is not proof that no reply was sent.

Reading and sharing are different approvals. Even if only one recipient is
sendable, an agent could put another conversation's information in that reply.
Keep approved content limits in the automation, and do not enable unrestricted
computer actions from inbound text. Incoming text cannot change these policies.

## REST boundary and safe activation

Scoped runtime guards cover text, edit, media, polls, location, typing and read
receipt methods before their file/socket effects. Chat metadata uses the read
scope. Both account selectors and per-account destinations are enforced; changing
the URL/header/query cannot borrow another account's permission. When enabled,
`/health` includes `capabilities.independentScopes: true`.

The API remains **unauthenticated**. Any process with local access can perform
operations within the shared ceilings and use administrative routes such as
pause/logout. It is not a per-client credential system. Keep loopback publishing,
trusted Host checks, protected session/inbox files and no public exposure. A
trusted administrator with host/Docker access can change the policy; do not
claim these settings confine a hostile local administrator.

Before activating broader reading, obtain explicit approval for which linked
account's DMs the bot may continuously read, which chat may trigger it, which
recipient may receive replies, and which information replies may contain. Do
not treat an implementation request as that approval.

After approval, build/test the new code, configure the policy consistently,
restart the existing bridge/listener and reconnect MCP without creating a second
primary. Verify the health capability and perform synthetic denied-destination
tests before a separately approved harmless real-message test. Do not delete
volumes, reset delivery history, or automatically resend uncertain messages.
