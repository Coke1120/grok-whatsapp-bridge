# ADR 0005 — Authenticate REST and require explicit outgoing scopes

## Status

Accepted for source implementation. Deployment, credential provisioning and
broader account access require separate owner approval. Supersedes the
unauthenticated-control-plane and legacy-send exceptions in ADRs 0002–0004.

## Decision

Require a deployment-provided `WHATSAPP_API_TOKEN` on every HTTP route, including
health, account selection and administration. Validate it before opening the
bridge runtime; check one Bearer header before route processing. There is no
insecure bypass. Share the validation/header helper with listener, MCP and local
health/control clients. Deny redirects and keep API and webhook credentials
separate. MCP local inbox tools do not need an HTTP credential.

Require explicit account-qualified `sendChats` for every outgoing chat side
effect even when `WHATSAPP_SCOPES` is absent. Legacy inbound behavior remains;
reading and triggering never imply sending. Pairing tools distinguish a refused
connection from authentication and uncertain connectivity failures, and refuse
to start a competing session on the latter.

## Consequences

This intentionally breaks unauthenticated clients and legacy unscoped sends.
Bridge, listener, MCP and healthcheck configuration must migrate together without
deleting paired sessions or delivery history. Published v1.3.3 is not fixed by
setting an environment variable; use reviewed source until a separately
approved fixed release is available. See [migration](../api-security.md).

One shared credential identifies trusted bridge clients collectively, not
individual clients/accounts. Scope ceilings are not host-admin isolation, an
OS sandbox, historical-message access or permission to forward read content.
Loopback publishing and protected credentials/files remain mandatory.
