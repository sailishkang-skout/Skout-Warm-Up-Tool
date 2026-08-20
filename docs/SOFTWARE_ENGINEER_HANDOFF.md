# Software engineer handoff

**Primary document** for an external engineer integrating this warmup service
with the Skout AI main platform (or any other consumer).

The main-platform repository is **not** in this workspace and is not a
dependency of this service.

Also read:

- [`INTEGRATION_CONTRACT.md`](./INTEGRATION_CONTRACT.md) — pull API field detail
- [`PRODUCTION_HANDOFF.md`](./PRODUCTION_HANDOFF.md) — operations checklist
- [`ENVIRONMENT_REFERENCE.md`](./ENVIRONMENT_REFERENCE.md) — environment variables
- [`DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md) — backup/restore assumptions
- [`PRIVACY.md`](./PRIVACY.md) — PII handling
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — internals
- [`WARMUP_NETWORK.md`](./WARMUP_NETWORK.md) — global partner **recipients** (opt-in; default off)
- [`WARMUP_POOL_ROTATION.md`](./WARMUP_POOL_ROTATION.md) — tenant **sending-identity** pools
- [`MAILBOX_INFRASTRUCTURE.md`](./MAILBOX_INFRASTRUCTURE.md) — domains, managed providers, kill switch, quarantine, operational mailbox states (migration 032)
- [`PROVIDER_ARCHITECTURE.md`](./PROVIDER_ARCHITECTURE.md) — Adapter vs directory provider

**The integration contract exposes policy/integration signals, not the
internal conversation event stream.**

**DELIVERY = AT-LEAST-ONCE. CONSUMER DEDUPE KEY = `eventId`.**

The external engineer **MUST** consume `GET /api/v1/integration-events`,
**MUST** deduplicate using `eventId`, and **MUST NOT** assume exactly-once
delivery.

---

## 1. What this service does

Standalone TypeScript/Node.js microservice that:

- Connects mailboxes (Gmail, Microsoft 365, SMTP/IMAP metadata)
- Runs **warmup** (profile, session, safety gate, ramp, send windows, intents)
- Sends warmup mail via Gmail / Microsoft 365 (`sendMessage`)
- Ingests inbound and outbound **conversation facts**
- Classifies messages into **facts** (deterministic ± optional AI)
- Evaluates **policy signals** (not actions)
- Records signals in a durable Postgres **outbox**
- Exposes authenticated **pull** of those events

---

## 2. What this service does NOT do

**MAIN PLATFORM OWNS** (not implemented here):

- CRM / contact records
- Suppression source of truth
- Sequence state and sequence policy
- Outreach execution
- LinkedIn
- Business actions
- CRM synchronization
- External action execution

This service does not call the platform. There is no webhook publisher,
Kafka, BullMQ job processing, Redis queue, or outbound HTTP publisher.

---

## 3. Architecture

```
MAILBOX
  → WARMUP
  → OPTIONAL WARMUP NETWORK (partner recipient; default WARMUP_NETWORK_ROUTING_MODE=off)
  → PROVIDER SEND
  → INBOUND
  → CONVERSATIONS
  → CLASSIFICATION
  → POLICY
  → INTEGRATION EVENTS
  → EXTERNAL MAIN PLATFORM (pull)
```

Warmup owns volume, ramp, schedule, safety, risk, reputation, intents, retry, and `SEND_UNKNOWN`. Network routing only chooses the partner **recipient**. Tenant **warmup-pool** (030) is an optional sender selector and is **not** wired into the daily scheduler.

Postgres is the system of record (migrations **001–030**). Redis (`ioredis`)
is used for OAuth state, mailbox connection locks, DNS cache, and assessment
invalidation — **not** a job queue. Workers use Postgres leases
(`FOR UPDATE SKIP LOCKED`).

---

## 4. Components

| Area | Location |
|---|---|
| HTTP API | `src/server.ts`, `src/app.ts` |
| Tenancy / API keys | `src/modules/tenancy`, `src/modules/auth` |
| Mailboxes / OAuth | `src/modules/mailbox`, `src/modules/oauth`, `src/modules/providers` |
| Warmup | `src/modules/warmup` |
| Warmup network (global partner **recipients**, 029) | `src/modules/warmup-network` |
| Warmup pool (tenant **senders**, 030; scheduler not wired) | `src/modules/warmup-pool` |
| Health / risk / reputation / policy (warmup) | `src/modules/health`, `risk`, `reputation`, `policy` |
| Conversations / classification / policy signals / outbox | `src/modules/conversations` |
| Config / DB / Redis / logs | `src/shared/` |

---

## 5. Database / migrations

Forward-only SQL in `migrations/` **001–030**. Checksums recorded. **Do not
edit applied files.** The API does **not** auto-migrate. **029** = global
warmup **network** (partner recipients). **030** = tenant sending-identity
**pools** (separate).

```
npm run migrate:up
npm run migrate:status
npm run migrate:validate
```

Run `migrate:up` **before** serving traffic. Migration **028** rejects
UPDATE/DELETE on `integration_events_outbox` (TRUNCATE still allowed for
ops/tests).

---

## 6. Workers

| Process | Production | Dev | Interval | Role |
|---|---|---|---|---|
| Warmup | `npm run start:worker` | `npm run worker:dev` | 30s | Execution intents / daily advance |
| Inbound | `npm run start:inbound` | `npm run inbound:dev` | 30s | Inbound sync + outbound materialize |
| Classification | `npm run start:classification` | `npm run classification:dev` | 15s | Message/domain facts |
| Policy | `npm run start:policy` | `npm run policy:dev` | 15s | Signals + outbox insert |

All four require Postgres **and** Redis at boot. Poll intervals default to
the table above and are configurable via `*_WORKER_POLL_INTERVAL_MS`.
Without classification + policy, conversations exist but policy integration
events will not appear.

SIGTERM/SIGINT: finish the **current tick**, then exit. Leases expire (~60s)
and are reclaimed.

---

## 7. API

Production: `npm start` (`node dist/server.js`). Dev: `npm run dev`.
Default port **3010**.

Integration pull: `GET /api/v1/integration-events` (read-only).

Correlation (same Bearer key):

- `GET /api/v1/conversations?mailboxId=`
- `GET /api/v1/conversations/:id`
- `GET /api/v1/conversations/:id/messages`
- `GET /api/v1/mailboxes`

No POST/PATCH/DELETE on integration events. No ACK endpoint.

---

## 8. Authentication

```
Authorization: Bearer <tenant-api-key>
```

Tenant identity comes **only** from the verified key. Missing/invalid/revoked
key → **401** (generic message). First key: `npm run bootstrap:tenant`. More
keys: `POST /api/v1/credentials`. Recommend a dedicated
`main-platform-integration` credential per tenant. Provider OAuth is for
mailbox connect only. Never put keys in query strings.

---

## 9. Conversation facts

Normalized EMAIL conversations and messages (`conversations`,
`conversation_messages`). Inbound poller + outbound materializer. HTML is
not persisted (`html_body` null in application code). `text_body` capped at
64 KiB. Deduped. **Not** an execution engine — never calls `sendMessage`.

---

## 10. Classification

Separate worker. Deterministic-first; optional AI
(`AI_CLASSIFICATION_PROVIDER=none` by default). Writes labels and
`conversation_domain_facts`. Facts only — no suppressions, no warmup
changes. Inbound text is untrusted data, not instructions.

---

## 11. Policy signals

Separate worker. Maps domain facts to signals such as
`CONTACT_SUPPRESSION_REQUIRED`. `POSITIVE_RESPONSE` is a signal only and is
**not** an integration event. Signals are recommendations, not actions.

---

## 12. Integration events

Policy signals are inserted into `integration_events_outbox` in the **same
database transaction**. Status stays `RECORDED`. No publisher process.

---

## 13. Integration-event endpoint

```
GET /api/v1/integration-events
```

Query: `limit` (1–100, default 50), `cursor` (UUID), `eventType` (catalog),
`conversationId` (UUID). Errors: **401** auth, **400** invalid query/cursor.

---

## 14. Event schema

Canonical envelope:

```
eventId
tenantId
eventType
schemaVersion
createdAt
source
conversationId
messageId            (when applicable)
mailboxId            (when applicable)
executionIntentId    (when applicable)
payload
```

HTTP also returns: `occurredAt`, `eventVersion` (= `schemaVersion`),
`entityType` (`conversation`), `entityId` (= `conversationId`),
`idempotencyKey`, plus `policyVersion` / `sourceFactId` /
`sourcePolicySignalId` when known.

`source` is `conversation-intelligence`. `payload` never includes bodies,
HTML, prompts, tokens, or credentials. `contactIdentifier` is a bounded
email when known. `eventId` is **not** the table PK `id`.

---

## 15. schemaVersion

Integer stored at insert (`event_version`). Current writes use **1**. Never
infer from `eventType`. New payload shapes require a new integer. Old rows
keep old JSON.

---

## 16. contractVersion

HTTP envelope: `conversation-integration/v1`. Header:
`X-Integration-Contract-Version`. Ignore unknown additive JSON keys.

---

## 17. eventId

Immutable UUID assigned at insert. **Consumer dedupe key.** Unique in the
outbox. Never regenerated on read.

---

## 18. Tenant isolation

List/get queries filter `tenant_id` from the authenticated credential.
Foreign conversation → **404**. Foreign event cursor → **400**.

---

## 19. Correlation IDs

No CRM contact IDs. Map:

```
conversation/message
  → payload.contactIdentifier
    or GET /api/v1/conversations/:id/messages (sender / recipients)
  → participant email
  → your CRM contact
```

Also persist `tenantId`, `mailboxId`, `conversationId`, `messageId`,
`executionIntentId` when present. `executionIntentId` is often absent on
inbound.

---

## 20. Pagination

Keyset: `ORDER BY created_at ASC, event_id ASC`. `cursor` is exclusive last
fully processed `eventId`. `hasMore` + `nextCursor`. Offset is not supported.

---

## 21. Checkpointing

Persist checkpoint **after** successful processing. If `hasMore`, save
`nextCursor`. Else save the last `eventId` on the page. Crash before save →
replay (expected).

---

## 22. At-least-once delivery

No ACK, lease, or exactly-once claim. Concurrent GETs return the same
`eventId`s. Events remain `RECORDED`.

**DELIVERY = AT-LEAST-ONCE**

---

## 23. Duplicate handling

**CONSUMER DEDUPE KEY = `eventId`.** Use a unique constraint in **your**
store in the same transaction as side effects. Producer uniqueness:
`(tenant_id, idempotency_key)`.

---

## 24. Crash recovery

API: SIGTERM/SIGINT drains HTTP, then closes Postgres and Redis. Workers:
finish current tick. Your consumer: resume from last checkpoint; unique
`eventId` makes replay safe. Policy+outbox insert is one transaction — crash
before commit creates neither.

---

## 25. Late / out-of-order events

Stream order is **insert time** (`createdAt`), not domain time. A late
classification appears at the **tail**. `occurredAt` may be older. Use
`createdAt` for “what is new to me”. Do not assume globally perfect thread
order — use messages for timeline.

---

## 26. Unknown future event types

Still returned on the page (so pagination cannot skip rows). Ignore
processing; still checkpoint `eventId`. Query `eventType=` only accepts the
current catalog (**400** otherwise).

---

## 27. Historical immutability

Payloads are not rewritten on read. Migration 028 rejects UPDATE/DELETE on
the outbox. Do not reinterpret old `schemaVersion` payloads.

---

## 28. Retry behavior

| HTTP | Action |
|---|---|
| 5xx / network | Retry **same** cursor |
| 401 | Stop until the key works |
| 400 | Do not blindly retry; cursor/filter invalid |
| 200 | Process + checkpoint |

No server-side backoff contract on the pull.

---

## 29. Production startup order

1. Set production env (`DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`,
   `API_KEY_PEPPER`, `NODE_ENV=production`, plus OAuth/AI as needed).
2. `npm run migrate:up` (and `migrate:validate`).
3. Start API: `npm start`. Probe `/health` then `/readiness`.
4. Start four workers (`start:worker`, `start:inbound`,
   `start:classification`, `start:policy`).
5. Bootstrap tenant/API keys if needed.
6. Point the platform consumer at `GET /api/v1/integration-events`.

No process manager is bundled.

---

## 30. Migrations

See §5. Production must apply **001–030** (forward-only; checksums recorded).
Do not skip **029–030** even when `WARMUP_NETWORK_ROUTING_MODE=off`.

- **026–027** — outbox envelope columns
- **028** — `integration_events_outbox` rejects UPDATE/DELETE (TRUNCATE still allowed for ops/tests)
- **029** — global partner warmup-network (recipients)
- **030** — tenant sending-identity pools (senders; scheduler not wired)

---

## 31. Health / readiness

| Endpoint | Auth | Meaning |
|---|---|---|
| `GET /health` | none | Process alive. No DB/Redis check. |
| `GET /readiness` | none | Postgres + Redis. **503** if either is down. |

Workers do not serve HTTP.

---

## 32. Logging / security expectations

Logs redact Authorization, tokens, API keys, encryption keys
(`sanitizeForLogging` + pino paths). Event payloads strip bodies/tokens.
TLS in production. Conversation message APIs may return `textBody` (PII).
Classification must not treat inbound mail as instructions to mutate warmup
or CRM.

---

## 33. External main-platform responsibilities

**THIS SERVICE OWNS:** mailbox connectivity, warmup execution, conversation
ingestion, conversation facts, classification facts, policy signals,
integration-event production.

**MAIN PLATFORM OWNS:** CRM/contact records, suppression source of truth,
sequence state, sequence policy, outreach execution, LinkedIn, business
actions.

The platform stores per-tenant API keys, checkpoints, and CRM mapping.

---

## 34. Integration example

```http
GET /api/v1/integration-events?limit=50 HTTP/1.1
Host: warmup.internal
Authorization: Bearer <tenant-api-key>
```

Continuation: `?limit=50&cursor=<eventId>`.

Example 200 body (abridged): `contractVersion` =
`conversation-integration/v1`, `events[]` with `eventId`, `tenantId`,
`eventType`, `schemaVersion`, `createdAt`, `source`, `conversationId`,
`messageId`, `mailboxId`, `payload.contactIdentifier`, `hasMore`.

Full JSON example: [`INTEGRATION_CONTRACT.md`](./INTEGRATION_CONTRACT.md).

---

## 35. Consumer pseudocode

Checkpoint **only after** successful processing. Replay is expected.
Duplicate delivery is expected. Unknown types must not crash. Do not assume
globally perfect order. **`eventId` is the dedupe key.**

```
checkpoint = loadCheckpoint(tenantId)

while true:
    response = GET integration-events(cursor=checkpoint)

    if response.status == 401:
        fail closed
    if response.status == 400:
        do not blindly retry
    if response.status >= 500:
        retry same cursor with backoff
        continue

    for event in response.events:
        if alreadyProcessed(event.eventId):
            continue

        if unsupported(event.eventType):
            checkpoint(event.eventId)
            continue

        beginTransaction()
        processEvent(event)
        markProcessed(event.eventId)
        commitTransaction()

    cursor = response.nextCursor   # or last eventId if !hasMore
    saveCheckpoint(tenantId, cursor)
    if not response.hasMore:
        sleep(pollInterval)
```

---

## 36. Failure scenarios

- Worker down: new events stop; existing outbox rows remain.
- Consumer crash mid-page: replay + dedupe.
- Late OOO/unsubscribe: appears at tail; re-evaluate **current** CRM/sequence
  state.
- `executionIntentId` missing: normal for inbound.
- SMTP/IMAP send absent: those mailboxes cannot execute warmup send.

---

## 37. Troubleshooting

| Symptom | Check |
|---|---|
| Empty events | Classification + policy workers running? Facts present? |
| 401 | Bearer key, tenant ACTIVE, credential not expired |
| 400 cursor | Cursor UUID belongs to **this** tenant |
| `/readiness` 503 | Postgres and Redis from `DATABASE_URL` / `REDIS_URL` |
| Process refuses start in production | `ENCRYPTION_KEY` / `API_KEY_PEPPER` ≥32 chars, URLs set |
| OAuth connect fails | All-or-nothing Google/Microsoft env group + redirect URI |
| Duplicate CRM writes | Unique(`eventId`) missing on your side |

---

## 38. Known limitations

- Lifecycle/audit events (`CONVERSATION_CREATED`, etc.) are **not** the
  integration pull.
- `executionIntentId` often absent on inbound.
- No CRM contact IDs.
- Poll intervals default to 30s/15s and are env-configurable.
- Worker claim leases remain ~60s on frozen claim paths (warmup/inbound/classification/policy).
- `bullmq` is not a dependency; leases are Postgres.
- Audit persist fail-open.
- Workers require Redis at boot.
- Message APIs may return `textBody` (PII).
- SMTP/IMAP `sendMessage` not implemented.
- No application Dockerfile / process manager (Compose is local
  Postgres+Redis on **5433/6380**).
- Provider send is at-least-once (`SEND_UNKNOWN` needs human reconciliation).
- Delivery-event ingestion is authenticated internal POST, not a verified
  provider webhook.
- `SERVICE_VERSION` default is `0.1.0` unless set.
- Warmup-network tables ≠ a live partner fleet. Default routing is `off`. See `docs/WARMUP_NETWORK.md`.

**Explicitly out of scope:** CRM, contacts, suppression lists, sequences,
LinkedIn, outreach, business-action agents, webhooks, Kafka, BullMQ
processing, Redis queues, outbound publisher, new event types, historical
payload rewrites.
