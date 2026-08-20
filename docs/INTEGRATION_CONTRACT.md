# Integration contract — conversation intelligence events

This document is the pull-API contract for an **external main-platform engineer**. Start with [`SOFTWARE_ENGINEER_HANDOFF.md`](./SOFTWARE_ENGINEER_HANDOFF.md) if you are integrating for the first time.

This service owns facts, policy signals, and a durable **pull** outbox. It does **not** own CRM, contacts, suppression lists, sequences, LinkedIn, or outreach execution. Do not call this API expecting those systems to exist here.

**The integration contract exposes policy/integration signals, not the internal conversation event stream.**

`CONVERSATION_CREATED` is an **internal audit** event. `CONVERSATION_UPDATED`, `MESSAGE_RECEIVED`, and `MESSAGE_SENT` are reserved in the producer catalog but are **not** written to `integration_events_outbox` by the current policy mapper. They are not the external pull contract. Conversation facts remain available on authenticated conversation APIs when the platform needs participant emails.

**POLICY SIGNALS → INTEGRATION EVENTS.** Lifecycle/audit events stay internal.

Contract version: `conversation-integration/v1`  
Payload schema version (current writes): `schemaVersion: 1`

**Delivery = at-least-once. Consumer dedupe key = `eventId`.**

---

## 1. Endpoint

```
GET /api/v1/integration-events
```

Authenticated, tenant-scoped pull of append-only outbox rows. There is **no ACK**, no delete, no webhook, and no publisher process.

Optional read models for correlation (same API key, same tenant):

- `GET /api/v1/conversations?mailboxId=`
- `GET /api/v1/conversations/:id`
- `GET /api/v1/conversations/:id/messages`

`GET /api/v1/warmup-network/*` is authenticated operator metadata for the global partner pool. It is **not** this pull API and must not be used as an event feed.

---

## 2. Authentication

Use the existing tenant API key. Do not send anonymous requests.

```
Authorization: Bearer <tenant-api-key>
```

- Keys are issued per tenant (`bootstrap-tenant` CLI, then `POST /api/v1/credentials`).
- Tenant identity comes **only** from the verified key. Never send `tenantId` as a trusted body/query field.
- Missing, malformed, revoked, expired, or wrong keys return **401** with a generic message.
- A key for tenant A cannot read tenant B’s events (empty page or **400** on a foreign cursor).

Recommended: issue a dedicated credential named e.g. `main-platform-integration` per tenant and store it in the platform’s secret store. This is still the existing API-key mechanism (not OAuth, not a second identity system).

---

## 3. Request parameters

| Query | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | `50` | Min `1`, max `100` |
| `cursor` | UUID | — | Exclusive continuation: last `eventId` you **fully processed** |
| `eventType` | string | — | Must be a known catalog type or the request is **400** |
| `conversationId` | UUID | — | Optional filter |

Unknown query values that fail validation return **400**.

---

## 4. Pagination

Keyset on **insert time**, not domain time:

```
ORDER BY created_at ASC, event_id ASC
```

- `hasMore: true` ⇒ use `nextCursor` (equals the last `eventId` in that page).
- `hasMore: false` ⇒ omit `nextCursor`; you are caught up **as of that read**.
- Offset pagination is not supported.
- Checkpoint **after** successful processing of a page (or of each `eventId`). If you crash before saving the cursor, you will see the same `eventId`s again — that is required.

---

## 5. Response schema

```json
{
  "contractVersion": "conversation-integration/v1",
  "events": [ /* IntegrationEventConsumerRecord */ ],
  "hasMore": true,
  "nextCursor": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}
```

Header (same value as `contractVersion`):

```
X-Integration-Contract-Version: conversation-integration/v1
```

---

## 6. Event schema

Each element of `events`:

| Field | Required | Meaning |
|---|---|---|
| `eventId` | yes | Immutable UUID. Dedup key. **Not** the table PK `id`. |
| `tenantId` | yes | Owning tenant |
| `eventType` | yes | Opaque string. Ignore types you do not implement. |
| `schemaVersion` | yes | Payload schema written at insert. Never infer from `eventType`. |
| `createdAt` | yes | Outbox insert time (ISO-8601). Pagination clock. |
| `source` | yes | Always `conversation-intelligence` today |
| `conversationId` | yes* | Conversation aggregate (`entityId` is the same value) |
| `messageId` | when applicable | Source message |
| `mailboxId` | when applicable | Sending/receiving mailbox in this service |
| `executionIntentId` | when applicable | Warmup send intent, if the message was linked |
| `payload` | yes | **Historically immutable** JSON object |
| `occurredAt` | yes | Domain time (policy/signal time). May be earlier than `createdAt`. |
| `eventVersion` | yes | Same integer as `schemaVersion` (compat alias) |
| `entityType` | yes | `conversation` |
| `entityId` | yes | Same as `conversationId` |
| `idempotencyKey` | yes | Producer insert key (`tenantId:policySignalId:eventType:v{schemaVersion}`) |
| `policyVersion` | when applicable | Policy evaluator version |
| `sourceFactId` | when applicable | Domain fact row |
| `sourcePolicySignalId` | when applicable | Policy signal row |

\*Current producers always attach a conversation. Treat missing conversation as “skip processing, still checkpoint”.

**Do not mutate or reinterpret `payload` by `eventType`.** A new payload shape requires a new `schemaVersion`. Rows with `schemaVersion: 1` keep the v1 meaning forever.

Payloads never include bodies, HTML, prompts, tokens, or credentials. `contactIdentifier` is a bounded email string when known.

---

## 7. Event types

Producer catalog (policy-derived types are what you will actually see on this endpoint today):

| `eventType` | Typical payload | Suggested platform use (you own the action) |
|---|---|---|
| `CONTACT_SUPPRESSION_REQUIRED` | suppression-shaped | Consider unsubscribe/complaint suppression in **your** store |
| `TEMPORARY_CONTACT_PAUSE` | pause-shaped | Consider pausing **your** sequence |
| `FOLLOW_UP_OPPORTUNITY` | follow-up-shaped | CRM/sequence follow-up **you** decide |
| `MEETING_REQUESTED` | meeting-shaped | CRM activity **you** decide |
| `CONTACT_REVIEW_REQUIRED` | review-shaped | Human review **you** decide |
| `NEGATIVE_RESPONSE` | negative-shaped | Sequence/CRM **you** decide |
| `SPAM_SIGNAL` | spam-shaped | Reputation/suppression **you** decide |
| `OUT_OF_OFFICE` | ooo-shaped | Pause **you** decide |
| `REFERRAL_DETECTED` | referral-shaped | CRM **you** decide |
| `QUESTION_DETECTED` | question-shaped | CRM **you** decide |
| `CONVERSATION_UPDATED` | reserved | In taxonomy/outbox check; **not emitted** to this pull today (audit only) |
| `MESSAGE_RECEIVED` | reserved | Same — inbound is a conversation fact, not an outbox event today |
| `MESSAGE_SENT` | reserved | Same — outbound materialization is a conversation fact, not an outbox event today |

This service **never** emits `STOP_SEQUENCE`, `CREATE_SUPPRESSION`, `CREATE_CRM_TASK`, or `SEND_FOLLOWUP`. Those are consumer actions.

`POSITIVE_RESPONSE` is a **policy signal only** and is not an integration event.

---

## 8. Correlation IDs

This service has **no CRM contact IDs**. Match as follows:

```
event.tenantId
  → your workspace/tenant mapping (you store the API key ↔ tenant)

event.mailboxId
  → mailbox in this service (GET /api/v1/mailboxes)
  → your user/inbox mapping (you own this)

event.conversationId + event.messageId
  → GET /api/v1/conversations/:id/messages
  → message.sender / message.recipients (emails)
  → payload.contactIdentifier (when present: inbound sender, else first outbound recipient)

email / participant
  → your CRM contact (you own the match: exact email, domain, etc.)

event.executionIntentId
  → warmup send intent in this service (outbound only, often absent)
```

Stable join keys to persist on your side: `eventId` (idempotency), plus `(tenantId, conversationId, messageId)` for thread identity.

---

## 9. Idempotency

- **Producer:** unique `(tenant_id, idempotency_key)` on insert. Retried policy evaluation does not duplicate the same signal+version.
- **Consumer (required):** deduplicate on **`eventId`**. Concurrent GETs and replayed cursors return the same IDs.

At-least-once is the only delivery guarantee. Exactly-once is **not** provided.

---

## 10. Retry semantics

| Situation | What happens |
|---|---|
| Your HTTP GET fails | Retry GET with the **same** cursor. Events stay `RECORDED`. |
| You process then crash before saving cursor | Next GET returns those `eventId`s again. Dedupe. |
| You save cursor then crash mid-page | Replay from last saved `eventId`; skip already applied IDs. |
| This service restarts | Outbox is durable Postgres. No drain/ACK. |
| Policy worker retries | Same idempotency key → one outbox row. |

There is no backoff contract on the pull endpoint beyond normal HTTP retries you implement.

---

## 11. Ordering

- Pages are ordered by **`createdAt`, then `eventId`**.
- **`occurredAt` can be out of order** relative to the stream (late classification). A row with an old `occurredAt` is appended at insert time and appears **after** your cursor, not in the middle of an already-consumed page.
- Do not assume global order across tenants.
- Do not assume `eventType` order matches conversation timeline; use `messageId` + conversation messages for thread order.

---

## 12. Versioning

- HTTP envelope: `contractVersion` / `X-Integration-Contract-Version`. Additive fields may appear; do not fail closed on unknown JSON keys.
- Payload: `schemaVersion`. New shapes ⇒ new integer. Old rows keep old payloads.
- Unknown `eventType`: **deliver and ignore**. Still advance the checkpoint. Do not drop them from your cursor math.
- Filtering `eventType` on the query string only accepts the **current producer catalog**.

---

## 13. Example request

```http
GET /api/v1/integration-events?limit=50 HTTP/1.1
Host: warmup.internal
Authorization: Bearer <tenant-api-key>
```

Continuation:

```http
GET /api/v1/integration-events?limit=50&cursor=11111111-1111-4111-8111-111111111111 HTTP/1.1
Authorization: Bearer <tenant-api-key>
```

---

## 14. Example response

```json
{
  "contractVersion": "conversation-integration/v1",
  "events": [
    {
      "eventId": "11111111-1111-4111-8111-111111111111",
      "tenantId": "22222222-2222-4222-8222-222222222222",
      "eventType": "CONTACT_SUPPRESSION_REQUIRED",
      "schemaVersion": 1,
      "createdAt": "2026-08-19T00:01:02.000Z",
      "source": "conversation-intelligence",
      "occurredAt": "2026-08-19T00:01:02.000Z",
      "entityType": "conversation",
      "entityId": "33333333-3333-4333-8333-333333333333",
      "conversationId": "33333333-3333-4333-8333-333333333333",
      "messageId": "44444444-4444-4444-8444-444444444444",
      "mailboxId": "55555555-5555-4555-8555-555555555555",
      "payload": {
        "tenantId": "22222222-2222-4222-8222-222222222222",
        "conversationId": "33333333-3333-4333-8333-333333333333",
        "messageId": "44444444-4444-4444-8444-444444444444",
        "contactIdentifier": "lead@example.com",
        "reason": "UNSUBSCRIBE",
        "sourceFactId": "66666666-6666-4666-8666-666666666666",
        "policyVersion": "conversation-policy/v1",
        "occurredAt": "2026-08-19T00:01:02.000Z",
        "priority": "CRITICAL"
      },
      "eventVersion": 1,
      "policyVersion": "conversation-policy/v1",
      "sourceFactId": "66666666-6666-4666-8666-666666666666",
      "sourcePolicySignalId": "77777777-7777-4777-8777-777777777777",
      "idempotencyKey": "22222222-2222-4222-8222-222222222222:77777777-7777-4777-8777-777777777777:CONTACT_SUPPRESSION_REQUIRED:v1"
    }
  ],
  "hasMore": false
}
```

---

## 15. Consumer implementation pseudocode

Checkpoint only after successful processing. Replay is expected. Duplicate
delivery is expected. Unknown `eventType`s must not crash the consumer. Do
not assume globally perfect order. **`eventId` is the dedupe key.**

```
checkpoint = loadCheckpoint(tenantId)  // last fully processed eventId, or null

while true:
    response = GET /api/v1/integration-events?limit=100[&cursor=checkpoint]

    if response.status == 401:
        fail closed (rotate/check key)
    if response.status == 400:
        do not blindly retry the same cursor (invalid cursor)
    if response.status >= 500:
        retry same cursor with backoff
        continue

    for event in response.events:
        if alreadyProcessed(event.eventId):
            continue

        if unsupported(event.eventType) or unsupported(event.schemaVersion):
            checkpointEvent(event.eventId)   // still advance; do not crash
            continue

        beginTransaction()
        processEvent(event)                  // unique(eventId) in your store
        markProcessed(event.eventId)
        commitTransaction()

    if response.hasMore:
        checkpoint = response.nextCursor
        saveCheckpoint(tenantId, checkpoint)
    else:
        if response.events is not empty:
            checkpoint = response.events.last.eventId
            saveCheckpoint(tenantId, checkpoint)
        sleep(pollInterval)
```

Apply functions must be **idempotent** on `eventId` (unique constraint in your store).

---

## 16. Failure handling

| HTTP | Meaning | Consumer |
|---|---|---|
| 200 | Page of events | Process + checkpoint |
| 400 | Bad `limit` / `cursor` / `eventType` / `conversationId` | Fix input. Foreign cursor is invalid, not empty. |
| 401 | No/invalid key | Do not poll until credentials work |
| 5xx | Transient | Retry same cursor with backoff |

Late events: appear at the **tail** (`createdAt` now). Re-evaluate your CRM/sequence state; do not assume you can insert into a past sequence step without your own rules.

Out-of-order `occurredAt`: use `createdAt` for “what is new to me”, `occurredAt` / message `sentAt` for “when the email happened”.

---

## 17. Security requirements

- TLS in production; keys only in `Authorization`.
- Never log the raw API key or event payloads that might later grow PII beyond email.
- Scope: one key ⇒ one tenant. Do not share keys across tenants.
- This pull is an **internal** integration boundary, not a public webhook.
- Bodies and secrets are stripped from payloads; do not try to recover HTML from this API.

---

## 18. What the main platform owns

- CRM contacts, leads, companies
- Mapping email → contact
- Suppression storage and enforcement
- Sequence engine, enrollments, steps, pause/stop
- LinkedIn and outreach sends
- Business actions taken **because** of these events
- Consumer checkpoint, retries, and idempotent applies

---

## 19. What this service owns

- Mailboxes, warmup send, inbound/outbound **conversation facts**
- Classification and policy **signals**
- Durable `integration_events_outbox` and this GET contract
- Tenant API keys and audit of authentication

Pipeline:

```
MAILBOX → WARMUP → CONVERSATIONS → CLASSIFICATION → POLICY → INTEGRATION EVENTS
                                                              ↓
                                                    MAIN PLATFORM (external)
```
