# Privacy and data handling

This service is a mailbox warmup and conversation-intelligence pipeline.
It is **not** a CRM. The main platform owns contact records, suppression,
and sequences.

## PII stored

| Data | Where | Exposed on API |
|---|---|---|
| Mailbox email | `mailboxes` | Yes (mailbox APIs) |
| Partner warmup-network mailbox address | `warmup_network_mailboxes` | Yes (`GET /api/v1/warmup-network/mailboxes`) — **global read** for any authenticated tenant; no tenant write APIs |
| Message `sender` / `recipients` | `conversation_messages` | Yes (conversation message APIs) |
| Message `text_body` (capped 64 KiB) | `conversation_messages` | Yes (conversation message APIs) |
| `html_body` | Column exists; application persists **NULL** | No |
| `contactIdentifier` (email) | Integration-event `payload` | Yes (`GET /api/v1/integration-events`) |
| Encrypted provider OAuth tokens | `provider_credentials` | Never |
| Tenant API key hashes | `api_credentials` | Raw key shown **once** at issue |

## What is not stored in integration events or audit metadata

- Message bodies
- Raw MIME
- OAuth access/refresh tokens
- API keys / Authorization headers
- Raw provider JSON dumps

## Tenant isolation

All tenant data is scoped by authenticated `tenantId`. Foreign IDs return
404 (resources) or 400 (integration cursors).

## AI processing

Optional. Default `AI_CLASSIFICATION_PROVIDER=none` (deterministic only).
When enabled, bounded text is sent to the configured HTTP classifier.
Inbound text is untrusted data, not instructions. AI cannot execute
warmup send, suppression, or CRM actions.

## Retention and deletion

No automatic purge. Tenant/mailbox deletion, if required by policy, is an
operator procedure against Postgres (and consumer checkpoints). Outbox
rows are immutable (no UPDATE/DELETE) — deletion requires an explicit
future contract.

## Audit

Append-only `audit_events` with sanitized metadata. Must not contain
message bodies or credentials.

## Provider data

Gmail/Microsoft APIs are called with stored OAuth tokens. Tokens are
encrypted at rest (`ENCRYPTION_KEY`). Logs redact token-like keys.
