# Conversations

**Stage 13A/13B — conversation facts.** This module records what happened
on a mailbox (normalized EMAIL conversations and messages) and, in 13B,
classifies those messages into GTM **facts**. It does **not** stop
sequences, change warmup volume, send mail, or talk to LinkedIn/CRM/suppression.

Architecture:

```
Inbound poller (src/workers/inbound-poller-process.ts)
  → InboundMessageProvider (Gmail / Microsoft Graph)
  → normalize → dedupe → ConversationService
  → persist conversation + message
  → audit (after commit)

Outbound materializer
  → read SENT warmup_execution_intents
  → Gmail messages.get / Graph Sent Items (conservative match)
  → persist OUTBOUND message (or leave Graph 202 unlinked)
```

**Not an execution engine.** Warmup remains
`Risk → Safety gate → Policy → ExecutionWorker → ProviderAdapter.sendMessage`.
Conversations never call those.

**Polling, not webhooks.** Postgres-native leases on
`mailbox_inbound_sync_state` (`FOR UPDATE SKIP LOCKED`). No BullMQ.

**HTML is not persisted.** `html_body` stays NULL. `text_body` is capped at
64 KiB. Inbound content is untrusted data and must never be treated as LLM
instructions.

**Stage 13B — classification facts.** After a message is persisted, a
Postgres-leased classification job is claimed by
`conversation-classification-process.ts` (not the inbound poller). An
`ConversationClassifier` validates structured model JSON into labels,
confidence, and a conversation-level **fact projection**. Labels such as
`UNSUBSCRIBE` are facts only — this stage does not create suppressions,
stop sequences, send mail, or change warmup.

AI is optional (`AI_CLASSIFICATION_PROVIDER=none` by default). Deterministic
rules still classify unsubscribe/OOO/wrong-person/meeting/interest patterns
without an API key. Tests never need production credentials.

**Stage 13C — classification quality + domain facts.** Canonical multi-label
taxonomy, deterministic-first classification, bounded evidence, and append-only
`conversation_domain_facts`. Still FACTS-ONLY — no suppressions, sequences,
CRM, or warmup changes. Historical 13B labels remain readable; new results
emit canonical labels. Reclassification is a new `(classifier_version,
taxonomy_version)` row.

**Stage 14 — conversation policy signals.** After domain facts are persisted,
a separate Postgres-leased evaluator (`conversation-policy-process.ts`) maps
facts to downstream **signals** (`CONTACT_SUPPRESSION_REQUIRED`,
`TEMPORARY_CONTACT_PAUSE`, …). Signals are not actions — this stage does not
create suppressions, stop sequences, send mail, or talk to CRM.

**Stage 15 — integration contract.** Policy signals are recorded into a
minimal `integration_events_outbox` in the **same database transaction**.
Events are facts for future CRM / sequence / suppression consumers **on the
main platform**. This service does not publish HTTP to those systems, write
suppressions, stop sequences, or send mail. Delivery is at-least-once +
consumer idempotency on `eventId`. Stage 15 recorded events transactionally
and exposed authenticated `GET /api/v1/integration-events`. There is no
publisher process.

**Stage 16 — consumption contract.** The external main platform pulls the
same outbox via authenticated `GET /api/v1/integration-events`. Delivery is
at-least-once: consumers dedupe on durable `eventId`. Pagination is a
tenant-scoped keyset (`created_at`, `event_id`) with a continuation token
(`nextCursor`). There is no ACK, claim/lease, or publisher worker — events
are never deleted or rewritten. `schemaVersion` is stored `event_version`,
not inferred from `eventType`. CONTACT_SUPPRESSION_REQUIRED remains a
signal/event only.

**The integration contract exposes policy/integration signals, not the internal conversation event stream.**

**Stage 17 — integration contract hardening.** The pull envelope now includes
`source`, `createdAt`, `mailboxId`, and `executionIntentId` (when known)
without mutating historical `payload` JSON. HTTP responses include
`contractVersion`. This service still does not implement CRM, suppression,
sequences, or outreach. See `docs/INTEGRATION_CONTRACT.md`.

**Stage 18 — production handoff.** Outbox rows are database-immutable
(UPDATE/DELETE rejected). See `docs/PRODUCTION_HANDOFF.md`.

**Stage 19 — release freeze.** Contract and worker topology are frozen.
See `docs/SOFTWARE_ENGINEER_HANDOFF.md`.

**Target stage**: Stage 19 (frozen).
