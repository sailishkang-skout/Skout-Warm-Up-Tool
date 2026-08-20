# Production handoff — email warmup / conversation intelligence

This is the operational and integration handoff for an **external software engineer** connecting the Skout AI main platform to this service.

**Primary engineer document:** [`SOFTWARE_ENGINEER_HANDOFF.md`](./SOFTWARE_ENGINEER_HANDOFF.md). Canonical pull-API detail lives in [`INTEGRATION_CONTRACT.md`](./INTEGRATION_CONTRACT.md). Environment variables: [`ENVIRONMENT_REFERENCE.md`](./ENVIRONMENT_REFERENCE.md). Disaster recovery: [`DISASTER_RECOVERY.md`](./DISASTER_RECOVERY.md). Privacy: [`PRIVACY.md`](./PRIVACY.md). This document covers architecture, ownership, operations, and the checklist.

**The integration contract exposes policy/integration signals, not the internal conversation event stream.**

**Delivery = at-least-once. Consumer dedupe key = `eventId`.**

---

## 1. Architecture

```
MAILBOX
  → WARMUP (volume / ramp / schedule / safety / risk / reputation / intents / retry / SEND_UNKNOWN)
  → OPTIONAL WARMUP NETWORK (partner recipient only; default off)
  → PROVIDER SEND
  → INBOUND
  → CONVERSATIONS (inbound/outbound facts)
  → CLASSIFICATION (labels + domain facts)
  → POLICY (signals only)
  → INTEGRATION EVENTS (durable outbox)
  → EXTERNAL MAIN PLATFORM (pull consumer)
```

Tenant **warmup-pool** (030) is a separate optional **sender** selector. The daily scheduler is **not** wired to rotate through pools.

Postgres is the system of record. Redis is **not** a job queue: it holds OAuth state and per-mailbox connection locks (`ioredis` via `src/shared/redis`, not a Fastify plugin and not BullMQ). Workers use Postgres leases (`FOR UPDATE SKIP LOCKED`).

Optional **warmup-network** recipient routing (`WARMUP_NETWORK_ROUTING_MODE`, default **off**) selects a Skout partner mailbox as `to`. It is not a second scheduler or send-state machine. Tenant identity pools (030) are a separate sending-mailbox selector. See [`WARMUP_NETWORK.md`](./WARMUP_NETWORK.md). Deploying the schema does not create a live partner fleet.

Processes:

| Process | Entry | Role |
|---|---|---|
| API | `src/server.ts` | HTTP |
| Warmup worker | `src/workers/execution-worker-process.ts` | Send intents |
| Inbound poller | `src/workers/inbound-poller-process.ts` | Inbound + outbound materialize |
| Classification | `src/workers/conversation-classification-process.ts` | Facts |
| Policy | `src/workers/conversation-policy-process.ts` | Signals + outbox insert |

---

## 2. Service responsibilities

THIS SERVICE OWNS:

- mailbox connectivity (Gmail / Microsoft 365 / SMTP-IMAP metadata)
- warmup (profile, session, execution intents, send)
- conversation facts (threads, messages)
- classification facts
- policy evaluation (signals, not actions)
- integration event creation and authenticated pull

---

## 3. External integration boundary

```
FACTS → POLICY → INTEGRATION EVENTS
```

The main platform consumes `GET /api/v1/integration-events`. It does **not** receive webhooks and must not expect this service to call the platform.

`CONVERSATION_CREATED` is an **internal audit** event. `CONVERSATION_UPDATED` / `MESSAGE_RECEIVED` / `MESSAGE_SENT` exist in the producer catalog but are **not** written to the outbox today. They are **not** the integration pull. Use conversation HTTP APIs if you need participant emails.

MAIN PLATFORM OWNS:

- CRM/contact records
- suppression
- sequences
- outreach decisions
- LinkedIn
- business actions
- CRM synchronization
- external action execution

---

## 4. Integration endpoint

```
GET /api/v1/integration-events
```

Read-only. No POST/PATCH/DELETE, no ACK. Events remain `RECORDED` forever (append-only; mutation is rejected in the database as of migration 028).

---

## 5. Authentication

```
Authorization: Bearer <tenant-api-key>
```

- Missing or invalid credential → **401** (generic message)
- Tenant is taken only from the verified key
- Issue a dedicated key per tenant (`npm run bootstrap:tenant`, then `POST /api/v1/credentials`)
- No OAuth for this pull; provider OAuth is mailbox-connect only

---

## 6. Event schema

Required envelope: `eventId`, `tenantId`, `eventType`, `schemaVersion`, `createdAt`, `source`, `payload`.

When applicable: `conversationId`, `messageId`, `mailboxId`, `executionIntentId`.

`payload` is historically immutable. Compat fields: `eventVersion` (= `schemaVersion`), `occurredAt`, `entityType` (`conversation`), `entityId`, `idempotencyKey`.

HTTP body also includes `contractVersion`. Header: `X-Integration-Contract-Version`.

---

## 7. Event types

Emitted on the pull today (policy → outbox):

- `CONTACT_SUPPRESSION_REQUIRED`
- `TEMPORARY_CONTACT_PAUSE`
- `FOLLOW_UP_OPPORTUNITY`
- `MEETING_REQUESTED`
- `CONTACT_REVIEW_REQUIRED`
- `NEGATIVE_RESPONSE`
- `SPAM_SIGNAL`
- `OUT_OF_OFFICE`
- `REFERRAL_DETECTED`
- `QUESTION_DETECTED`

Reserved in taxonomy but **not** outbox-emitted: `CONVERSATION_UPDATED`, `MESSAGE_RECEIVED`, `MESSAGE_SENT`.

Never emitted: `STOP_SEQUENCE`, `CREATE_SUPPRESSION`, `CREATE_CRM_TASK`, `SEND_FOLLOWUP`.

Ignore unknown `eventType` values; still checkpoint `eventId`.

---

## 8. Correlation strategy

No CRM IDs exist here.

```
conversation/message
  → payload.contactIdentifier
    OR GET /api/v1/conversations/:id/messages → sender / recipients
  → your CRM contact (email match you own)
```

Also persist `tenantId`, `mailboxId`, `conversationId`, `messageId`, `executionIntentId` (outbound only, often absent), `eventId`.

Participant email **is** available on the authenticated messages API (`sender`, `recipients`). Message `textBody` may be present there; integration-event payloads do **not** include bodies.

---

## 9. Pagination

Keyset: `ORDER BY created_at ASC, event_id ASC`.

- `limit` default 50, max 100
- `cursor` = last **fully processed** `eventId` (exclusive)
- `hasMore` + `nextCursor`
- Invalid or foreign cursor → **400**
- `eventType` query filter must be a known catalog value or **400**

---

## 10. At-least-once semantics

There is no ACK, lease, or exactly-once claim on the outbox. Concurrent GETs with the same cursor return the same `eventId`s.

**DELIVERY = AT-LEAST-ONCE**

---

## 11. Deduplication

**CONSUMER DEDUPE KEY = `eventId`**

Producer uniqueness: `(tenant_id, idempotency_key)`.

Store applied `eventId`s in the platform (unique constraint) before side effects, or make applies idempotent on `eventId`.

---

## 12. Versioning

- `contractVersion`: `conversation-integration/v1` (HTTP envelope)
- `schemaVersion`: integer stored at insert (`event_version`). Do not infer from `eventType`
- New payload shapes require a new `schemaVersion`. Old rows keep old JSON
- Ignore extra JSON keys. Ignore unknown `eventType`s without breaking the cursor

---

## 13. Retry behavior

Retry failed GETs with the **same** cursor. Do not skip ahead on 5xx.

If you crash after processing but before saving the checkpoint, replay is expected; dedupe on `eventId`.

Policy/classification workers retry via Postgres leases (not Redis queues). Crashes before commit roll back signal+outbox together.

---

## 14. Failure handling

| Code | Meaning |
|---|---|
| 200 | Page |
| 400 | Bad query / cursor |
| 401 | Auth |
| 5xx | Retry same cursor |

Late events appear at the **tail** (`createdAt` = insert time). `occurredAt` may be older.

---

## 15. Tenant isolation

Every list/get for events, conversations, messages, classifications, and policy signals is `WHERE tenant_id = $1` using the authenticated tenant. Foreign conversation IDs → **404**. Foreign event cursors → **400**.

---

## 16. Security requirements

- TLS in production; API keys only in `Authorization` (never query string)
- Logs redact Authorization / tokens / secrets (`sanitizeForLogging` + pino paths)
- Audit metadata is sanitized before persist
- Event payloads strip bodies, HTML, prompts, tokens
- HTML is not persisted on messages (`html_body` stays null in application code); text bodies capped at 64 KiB
- Classification treats inbound text as untrusted data, not instructions to mutate warmup/CRM
- No outbound HTTP publisher to the platform

Privacy: conversation APIs can return `textBody`. Treat that as PII. Integration events expose email identifiers (`contactIdentifier`) without message bodies.

---

## 17. Operational requirements

- Run `npm run migrate:up` **before** serving traffic. The API does not auto-migrate; missing schema fails queries, not silently.
- SIGTERM/SIGINT: API drains in-flight requests then closes DB/Redis. Workers finish the current tick then exit. Leases expire (~60s) and are reclaimed — no duplicate durable facts/events (idempotency keys / unique constraints).
- Poll intervals are env-configurable (`WARMUP_WORKER_POLL_INTERVAL_MS`, `INBOUND_WORKER_POLL_INTERVAL_MS`, `CLASSIFICATION_WORKER_POLL_INTERVAL_MS`, `POLICY_WORKER_POLL_INTERVAL_MS`). Defaults: warmup **30s**, inbound **30s**, classification **15s**, policy **15s**.
- Observability is process-local counters in `src/shared/observability/metrics.ts` plus structured pino logs. There is **no OpenTelemetry exporter** in this repository (enhancement, not a missing product feature of the pull contract).
- Provider send timeout is hardcoded per adapter (~15s). Credential refresh timeout: `PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS` (default 10s).
- `/health` — process alive (no deps). `/readiness` — Postgres + Redis ping (503 if either down).
- Structured JSON logs (pino). Do not log raw keys.
- Warmup network (global partner **recipients**): leave `WARMUP_NETWORK_ROUTING_MODE=off` until a real eligible fleet exists. Seed with existing mailbox OAuth then SQL `INSERT` into `warmup_network_*`. Tenants cannot mutate the global pool. Distinct from tenant sending-identity pools (030). See `docs/WARMUP_NETWORK.md`. Google/Microsoft **directory** provisioning stays `NOT_CONFIGURED` until reseller/CSP env is set; code existence is not production activation.

---

## 18. Environment variables

Required:

- `DATABASE_URL` (postgres)
- `REDIS_URL` (redis / rediss)
- `ENCRYPTION_KEY` (≥32 chars)
- `API_KEY_PEPPER` (≥32 chars)

Common optional: `NODE_ENV`, `PORT` (default 3010), `LOG_LEVEL`, pool timeouts, Google/Microsoft OAuth **all-or-nothing** triples, AI classification (`AI_CLASSIFICATION_PROVIDER=none` by default).

See `.env.example` and [`ENVIRONMENT_REFERENCE.md`](./ENVIRONMENT_REFERENCE.md).

Redis is required at process start even for workers that lease in Postgres (OAuth/locks on the API; workers share the same config bootstrap).

---

## 19. Required workers

For a full pipeline into integration events:

1. API (`npm start`)
2. Warmup worker (`npm run start:worker`) — outbound mail
3. Inbound poller (`npm run start:inbound`) — inbound + outbound materialize
4. Classification (`npm run start:classification`)
5. Policy (`npm run start:policy`) — writes outbox

Without 4–5, conversations exist but outbox policy events will not appear.

---

## 20. Migration requirements

Forward-only SQL in `migrations/` (001–030). Checksums are recorded; **do not edit applied files**. Migration **029** is the global warmup **network** (partner recipients). Migration **030** is tenant **sending-identity** pools (senders) — do not confuse them. Both files are in this repository; apply both.

```
npm run migrate:up
npm run migrate:status
npm run migrate:validate
```

028 adds an UPDATE/DELETE reject trigger on `integration_events_outbox`. TRUNCATE (ops/tests) is still allowed.

---

## 21. Known limitations

- Lifecycle conversation events are not on the outbox
- `executionIntentId` often absent on inbound
- No CRM contact IDs
- Worker poll intervals are env-configurable (`*_WORKER_POLL_INTERVAL_MS`; defaults 30s/15s).
- Claim-path lease duration remains ~60s (not env; frozen execution/inbound/classification claim code).
- No OpenTelemetry SDK/exporter; scrape logs or add an exporter later.
- Audit writes fail-open (request still succeeds if audit insert fails)
- Workers require Redis connectivity at boot even when the tick path is Postgres-only
- Conversation message list can include `textBody` (PII)
- Warmup-network **tables are not a live Skout partner fleet**. Default `WARMUP_NETWORK_ROUTING_MODE=off`. There are no tenant write APIs; ops seed via mailbox OAuth + SQL. See `docs/WARMUP_NETWORK.md`. Migration 030 tenant identity pools are a different layer (sender WHO); scheduler is not wired to them.

---

## 22. Explicitly out-of-scope functionality

Do not look for: CRM, contacts, suppression lists, sequence engine, LinkedIn, outreach execution, webhooks, Kafka, BullMQ job processing, Redis queues, outbound platform publisher.

---

## 23. Integration checklist

- [ ] Run migrations
- [ ] Configure authentication
- [ ] Configure API endpoint
- [ ] Configure tenant credentials
- [ ] Start required workers
- [ ] Consume integration events
- [ ] Persist eventId checkpoints
- [ ] Deduplicate by eventId
- [ ] Handle unknown event types
- [ ] Handle schema versions
- [ ] Handle late events
- [ ] Handle retries
- [ ] Handle cursor replay
- [ ] Map participant email to CRM contact
- [ ] Never assume exactly-once delivery
- [ ] Never mutate historical events

---

## 24. Example consumer flow

1. Store per-tenant warmup API key and `tenantId`.
2. Poll `GET /api/v1/integration-events?limit=100` (then `cursor=`).
3. For each event: skip if `eventId` already applied.
4. If `eventType` unknown or `schemaVersion` unsupported: mark seen, do not fail the page.
5. Else map `contactIdentifier` / message `sender` to your CRM contact and apply **your** suppression/sequence/CRM rules.
6. Persist checkpoint = last processed `eventId` (or `nextCursor` when `hasMore`).
7. On crash: resume from last checkpoint; unique(`eventId`) makes replay safe.

Language-neutral `while true` consumer loop: [`SOFTWARE_ENGINEER_HANDOFF.md`](./SOFTWARE_ENGINEER_HANDOFF.md) §35.
