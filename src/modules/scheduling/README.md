# Scheduling

**Correction (Stage 12)**: this README originally described a BullMQ-based
design (job creation, retry/backoff, dead-letter handling, distributed
locking). That is not what got built, and Stage 12 — the stage that finally
made warmup execution actually run continuously — deliberately did not
build it that way either. `bullmq` remains a `package.json` dependency but
has zero real usage anywhere in this codebase (`src/shared/queue/` is an
empty directory); `docker-compose.yml` only runs Postgres and Redis, no
queue infrastructure. What Stage 8 actually built, and Stage 12 completed,
is a **Postgres-native** claim/lease/retry system:
`warmup_execution_intents`, atomic `FOR UPDATE SKIP LOCKED` claiming
(`warmup/infrastructure/postgres-warmup-execution-intent-repository.ts`),
lease-expiry reclaim with heartbeat renewal, and bounded exponential
backoff (`warmup/domain/retry-policy.ts`) — already concurrency-proven
(`tests/db/warmup-concurrency.test.ts`) before Stage 12 added the piece
that was actually missing: something to call it on a recurring basis. See
`warmup/README.md`'s "Scheduling (Stage 12)" section for the real
architecture: `application/warmup-scheduler.ts` (`WarmupScheduler.runTick`)
and `src/workers/execution-worker-process.ts`, both living in `warmup` and
`workers` respectively rather than a separate `scheduling` module, since
there is exactly one thing in this codebase that needs scheduling today
(warmup execution) and building a second, generic
job-queue abstraction for it — the way this README originally
envisioned — would have meant introducing infrastructure with no second
consumer to justify its own complexity.

Redis genuinely *is* used elsewhere in this service (OAuth
state/connection locks, `domain-intelligence`'s cache, the
`health`/`reputation` assessment-invalidation marker) — just never as a job
queue. Conversation inbound/classification/policy workers already run as
separate Postgres-leased poll loops (not this module, not BullMQ). Stage 19
freezes that topology: do not introduce BullMQ, Kafka, or Redis queues.

**Target stage**: originally Stage 7 (foundation). Superseded by Stage 12's
Postgres-native design — see `warmup/README.md`.
