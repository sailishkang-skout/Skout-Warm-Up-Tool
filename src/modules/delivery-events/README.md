# Delivery Events

**Responsibility**: ingestion, idempotent persistence, and window
aggregation of the normalized, provider-independent delivery-evidence
stream (`delivery_events`) — the raw evidence `reputation` computes rolling
windows over. This module records what happened; it never interprets what
it means for reputation/risk/policy, and it never touches warmup volume
itself (Stage 10 spec section 4).

**Boundary**:
- `domain/delivery-event.ts` — `DeliveryEventType`
  (`DELIVERED`/`BOUNCED`/`FAILED`/`THROTTLED`/`DEFERRED`/`REJECTED`/
  `COMPLAINT`/`UNKNOWN`). `UNKNOWN` is a first-class member, not an error
  fallback — a provider's `ACCEPTED`/`SENT` response at send time
  (`providers/domain/send-message.ts`) says nothing about whether the
  message was ever actually delivered; this codebase never fabricates a
  delivery event it doesn't have real evidence for.
- `computeDeliveryEventDedupeKey` — deterministic, mirrors
  `warmup/domain/warmup-execution-intent.ts`'s `computeIdempotencyKey`.
  Uses `tenant + provider + providerEventId` when the provider supplies
  one; otherwise falls back to `tenant + mailbox + provider + eventType +
  executionIntent + observedAt`. **Documented limitation**: the fallback
  cannot distinguish two genuinely independent events sharing every one of
  those fields at the exact same instant — a real constraint of ingesting
  events with no provider-native identity, not a bug.
- `application/delivery-event-service.ts` (`ingestDeliveryEvent`) —
  verifies tenant/mailbox ownership (via `mailboxService.getMailbox`,
  reusing existing tenant-isolation enforcement, never reimplemented),
  checks idempotency, persists, marks the mailbox's intelligence stale
  (`health/application/assessment-invalidation-store.ts` — the narrow,
  dependency-free port this module depends on directly rather than the
  full `MailboxAssessmentService`, which avoids a module dependency cycle:
  `health → reputation → delivery-events`), and audits safely. Deliberately
  does **not** touch warmup volume, a `WarmupSession`, or a
  `WarmupDecision` — that only ever happens through
  `reputation → risk → the existing decision engine` (Stage 10 spec
  section 4: "The ingestion service must NOT directly manipulate warmup
  volume").
- `api/delivery-event-routes.ts` — `POST /api/v1/internal/delivery-events`.
  Authenticated the same way every other route in this service is; there
  is **no real provider webhook endpoint yet** (no signature verification,
  no Gmail Pub/Sub push handling, no Microsoft Graph subscription
  validation). This is the deliberate, documented fallback Stage 10 spec
  section 5 allows: "If real webhook authentication cannot safely be
  implemented yet, build the normalized ingestion boundary and mocked
  adapter tests instead. DO NOT create an insecure accept-any-webhook
  endpoint." A future webhook handler normalizes a provider payload into
  exactly this same shape and calls the same `DeliveryEventService` — no
  provider-specific parsing belongs in this module's domain code; it stays
  inside `providers` (see that module's README).
- `metadata` must only ever hold safe, structural detail — never an
  access/refresh token, an Authorization header, a password, a full
  provider response body, or an email body. Enforced both by convention
  (like `health`'s `Evidence.metadata`) and defense-in-depth
  (`sanitizeForLogging` applied before the row reaches Postgres, same
  pattern `postgres-audit-event-recorder.ts` already uses).
- Append-only (`migrations/018_create_delivery_events.sql`) — no
  update/delete method exists on `DeliveryEventRepository` at all.
- **Stage 11**: `countByEventTypeForProvider`/`countByEventTypeForDomain`
  (and their `DeliveryEventService` counterparts
  `getProviderWindowStats`/`getDomainWindowStats`) aggregate across every
  mailbox a tenant sends through a given provider or sending domain, for
  `reputation`'s provider-/domain-level assessment (see
  `reputation/README.md`). Still one grouped-aggregate query each, always
  tenant-scoped; the domain variant joins to `mailboxes` rather than adding
  a domain column to this table. No new index — the existing `tenant_id`
  index already bounds these scans to a realistic size for this system's
  volumes (Stage 11 spec: "avoid speculative indexes").

**Target stage**: Stage 10, Stage 11 (provider/domain aggregation methods).
