# Scheduling

**Responsibility**: turns warmup schedules and other recurring/one-off domain
work into BullMQ jobs — job creation, retry/backoff policy, dead-letter
handling, job metadata (tenant id, mailbox id, correlation id), and distributed
locking so multiple worker instances never double-execute the same unit of work.

**Boundary**:
- Job *payloads* and *handlers* live with the domain module that owns the work
  (e.g. a warmup-send job's handler lives under `warmup`/`workers`, not here) —
  this module owns the queueing/retry/lock mechanics, not domain logic.
- All jobs are idempotent by construction: handlers must be safe to run twice
  for the same job id.

**Target stage**: Stage 7 (foundation), used by every subsequent worker.
