import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxAssessmentService } from "../../health/application/mailbox-assessment-service.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { Logger } from "../../../shared/logger/index.js";
import { isWithinSendWindow, nextWindowStart } from "../domain/send-window.js";
import { classifyRetry } from "../domain/retry-policy.js";
import type { WarmupExecutionIntent } from "../domain/warmup-execution-intent.js";
import { evaluateSafetyGate } from "./safety-gate.js";
import type { WarmupExecutionIntentRepository } from "./warmup-execution-intent-repository.js";
import type { WarmupProfileRepository } from "./warmup-profile-repository.js";
import type { WarmupSendProvider } from "./warmup-send-provider.js";
import type { WarmupSessionRepository } from "./warmup-session-repository.js";

const LEASE_DURATION_MS = 60_000;

/**
 * Lease-safety analysis (Stage 12 spec "LEASE REQUIREMENT" — "analyze
 * whether an active worker can legitimately execute longer than the
 * lease"): the critical section between `claimNext` and the final
 * `recordResult` includes `sendProvider.sendWarmupMessage`, which itself
 * may perform an OAuth token refresh (`resolveFreshCredential` →
 * `adapter.oauth.refreshAccessToken`) *before* the actual send call. Both
 * are now bounded: the send call by `SEND_TIMEOUT_MS = 15_000` (both
 * `gmail-adapter.ts` and `microsoft365-adapter.ts`), and — since Stage
 * 12.1 — the refresh call by `PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS`
 * (`shared/config/schema.ts`, default 10s), independently configured. A
 * timed-out refresh is classified distinctly (`ProviderError` with
 * `details: { reason: "timeout" }`, see the adapters) and surfaces as a
 * retryable `TEMPORARY_FAILURE` `ProviderSendResult`
 * (`adapter-warmup-send-provider.ts`), flowing through the exact same
 * `classifyRetry`/`recordResult` path below as any other retryable
 * failure — never a special case here.
 *
 * Even with both calls bounded, this section retains its own lease-renewal
 * heartbeat (`withLeaseHeartbeat` below) as defense-in-depth: it protects
 * against *any* source of slowness, not just network calls (a GC pause, a
 * slow DB round trip), and remains correct regardless of what future code
 * ends up in this critical section. `LEASE_HEARTBEAT_INTERVAL_MS` renews
 * at 1/3 of the lease duration — under normal operation (process alive,
 * Postgres reachable) the lease is refreshed roughly 3x before it could
 * expire, so `reclaimExpiredLeases` only ever finds genuinely dead
 * workers.
 *
 * **The guarantee this provides**: under normal operation, a legitimately
 * executing worker's lease is never reclaimed out from under it, so two
 * workers can never both reach `sendProvider.sendWarmupMessage` for the
 * same intent. This is *not* an absolute guarantee — a worker process that
 * pauses entirely (a long GC pause, a frozen container, a suspended VM) for
 * longer than the full lease duration could still miss every heartbeat and
 * have its lease reclaimed while a send it already issued is still in
 * flight. This codebase does not claim exactly-once provider delivery in
 * that case (nothing could, without a provider-side idempotency token —
 * see `SEND_UNKNOWN`'s own documented limitation, Stage 9 spec section 7).
 * What this guarantees is: **at-least-once execution with a strong,
 * heartbeat-enforced reclaim boundary** — the closest to exactly-once this
 * architecture can honestly claim.
 */
const LEASE_HEARTBEAT_INTERVAL_MS = 20_000;

export interface ExecutionWorker {
  /**
   * Claims and processes exactly one execution intent, if any is currently
   * claimable. Returns `undefined` when there is nothing to do — callers
   * (a future scheduled trigger, or a test) are responsible for the polling
   * loop; this function is intentionally a single unit of work, not a
   * long-running process (Stage 8 spec section 30: "keep execution
   * conservative").
   */
  processNext(workerId: string): Promise<WarmupExecutionIntent | undefined>;
}

export interface CreateExecutionWorkerDeps {
  readonly intentRepository: WarmupExecutionIntentRepository;
  readonly sessionRepository: WarmupSessionRepository;
  readonly warmupProfileRepository: WarmupProfileRepository;
  readonly mailboxService: MailboxService;
  readonly mailboxAssessmentService: MailboxAssessmentService;
  readonly sendProvider: WarmupSendProvider;
  readonly auditRecorder: AuditEventRecorder;
  readonly logger: Logger;
}

export function createExecutionWorker(deps: CreateExecutionWorkerDeps): ExecutionWorker {
  const { intentRepository, sessionRepository, warmupProfileRepository, mailboxService, mailboxAssessmentService, sendProvider, auditRecorder, logger } = deps;

  async function cancel(intent: WarmupExecutionIntent, leaseOwner: string, safeReason: string): Promise<WarmupExecutionIntent> {
    const cancelled = await intentRepository.recordResult(intent.tenantId, intent.id, leaseOwner, {
      status: "CANCELLED",
      result: { status: "PERMANENT_FAILURE", provider: intent.provider, timestamp: new Date(), retryable: false, safeReason },
    });
    await auditRecorder.record({
      tenantId: intent.tenantId,
      eventType: "WARMUP_EXECUTION_BLOCKED",
      actorType: "system",
      metadata: { mailboxId: intent.mailboxId, sessionId: intent.sessionId, intentId: intent.id, reason: safeReason },
    });
    return cancelled;
  }

  /**
   * Renews `intent`'s lease every `LEASE_HEARTBEAT_INTERVAL_MS` while `work`
   * is in flight — see this file's top-of-file lease-safety analysis for
   * why this exists and exactly what guarantee it provides. A failed
   * renewal is only logged, never thrown: the operation it's protecting
   * (a claim already held, possibly mid-provider-call) can't safely be
   * aborted partway through.
   */
  async function withLeaseHeartbeat<T>(intent: WarmupExecutionIntent, leaseOwner: string, work: () => Promise<T>): Promise<T> {
    const timer = setInterval(() => {
      intentRepository.renewLease(intent.tenantId, intent.id, leaseOwner, LEASE_DURATION_MS).then((renewed) => {
        if (!renewed) {
          logger.warn(
            { tenantId: intent.tenantId, intentId: intent.id, workerId: leaseOwner },
            "Lease renewal found the lease no longer held — it may already have been reclaimed",
          );
        }
      }).catch((err: unknown) => {
        logger.warn({ err, tenantId: intent.tenantId, intentId: intent.id, workerId: leaseOwner }, "Lease renewal request failed");
      });
    }, LEASE_HEARTBEAT_INTERVAL_MS);
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  return {
    async processNext(workerId: string): Promise<WarmupExecutionIntent | undefined> {
      const claimed = await intentRepository.claimNext(workerId, LEASE_DURATION_MS);
      if (!claimed) {
        return undefined;
      }

      return withLeaseHeartbeat(claimed, workerId, async () => {
        await auditRecorder.record({
          tenantId: claimed.tenantId,
          eventType: "WARMUP_INTENT_CLAIMED",
          actorType: "system",
          metadata: { mailboxId: claimed.mailboxId, sessionId: claimed.sessionId, intentId: claimed.id, attemptCount: claimed.attemptCount },
        });

        // Stale decision protection (Stage 8 spec section 17): everything
        // that justified this intent when it was created is re-fetched
        // fresh here, never trusted from the (possibly now-stale) decision
        // that created it. "It was valid when scheduled" is never
        // sufficient.
        const [session, mailbox, profile] = await Promise.all([
          sessionRepository.findById(claimed.tenantId, claimed.sessionId),
          mailboxService.getMailbox(claimed.tenantId, claimed.mailboxId),
          warmupProfileRepository.findByMailboxId(claimed.tenantId, claimed.mailboxId),
        ]);

        if (!session || !profile) {
          return cancel(claimed, workerId, "Warmup session or profile no longer exists.");
        }
        if (session.state !== "ACTIVE") {
          return cancel(claimed, workerId, `Warmup session is no longer ACTIVE (currently ${session.state}).`);
        }

        // Time/window eligibility (Stage 12) — deliberately checked before
        // the more expensive risk/reputation/safety-gate re-check below,
        // and deliberately never itself a safety decision: this only ever
        // answers "is now within the mailbox's configured send window,"
        // never "is this mailbox safe to send to" (that remains entirely
        // the safety gate's job, unchanged). A window-scheduled intent's
        // `scheduledFor` is already set to the window's opening instant at
        // creation time (see `warmup-service.ts`), so this claim-time
        // re-check only ever fires in the rare drift case (the window
        // closed between decision-time and claim-time, e.g. a backlogged
        // worker) — re-queued via `deferExecution`, never cancelled, so a
        // temporarily-closed window never costs the day's warmup volume.
        if (profile.windowStartMinute !== undefined && profile.windowEndMinute !== undefined) {
          const windowConfig = { timezone: mailbox.timezone, windowStartMinute: profile.windowStartMinute, windowEndMinute: profile.windowEndMinute };
          const now = new Date();
          if (!isWithinSendWindow(windowConfig, now)) {
            return intentRepository.deferExecution(claimed.tenantId, claimed.id, workerId, nextWindowStart(windowConfig, now));
          }
        }

        const [assessment, capabilities] = await Promise.all([
          mailboxAssessmentService.getAssessment(claimed.tenantId, claimed.mailboxId),
          mailboxService.getCapabilities(claimed.tenantId, claimed.mailboxId),
        ]);
        const gate = evaluateSafetyGate({
          sessionState: session.state,
          mailboxEnabled: mailbox.enabled,
          health: assessment.health,
          riskLevel: assessment.risk.riskLevel,
          eligibility: assessment.eligibility.decision,
          recommendedVolume: claimed.volume,
          maximumVolume: Math.max(claimed.volume, profile.maximumDailyVolume),
          profileActive: profile.active,
          pauseConditions: profile.pauseConditions,
          providerCanSend: capabilities.canSend,
        });
        if (!gate.passed) {
          return cancel(claimed, workerId, gate.reasons[0] ?? "Safety gate re-check failed at execution time.");
        }

        await intentRepository.markSending(claimed.tenantId, claimed.id, workerId);

        const result = await sendProvider.sendWarmupMessage({
          tenantId: claimed.tenantId,
          mailboxId: claimed.mailboxId,
          provider: claimed.provider,
          volume: claimed.volume,
          idempotencyKey: claimed.idempotencyKey,
        });

        if (result.status === "ACCEPTED") {
          return intentRepository.recordResult(claimed.tenantId, claimed.id, workerId, { status: "SENT", result });
        }

        // Stage 9 spec section 7 — the single most important rule in this
        // stage: the provider's actual receipt of the send could not be
        // confirmed, so this can NEVER be treated as retryable. A retry
        // here risks sending a genuine duplicate, since neither Gmail nor
        // Microsoft Graph expose a client-supplied idempotency token. This
        // intent is left in `SEND_UNKNOWN` — terminal, never reclaimed by
        // `claimNext` (which only selects `PENDING`) — for manual
        // reconciliation. Deliberately checked before `classifyRetry`, not
        // folded into its generic logic, so this can never accidentally
        // become retryable through a future change to that function.
        if (result.status === "SEND_UNKNOWN") {
          await auditRecorder.record({
            tenantId: claimed.tenantId,
            eventType: "WARMUP_EXECUTION_UNKNOWN",
            actorType: "system",
            metadata: { mailboxId: claimed.mailboxId, sessionId: claimed.sessionId, intentId: claimed.id },
          });
          return intentRepository.recordResult(claimed.tenantId, claimed.id, workerId, { status: "SEND_UNKNOWN", result });
        }

        const retryDecision = classifyRetry(result, claimed.attemptCount);
        await auditRecorder.record({
          tenantId: claimed.tenantId,
          eventType: "WARMUP_EXECUTION_FAILED",
          actorType: "system",
          metadata: {
            mailboxId: claimed.mailboxId,
            sessionId: claimed.sessionId,
            intentId: claimed.id,
            status: result.status,
            willRetry: retryDecision.shouldRetry,
          },
        });

        if (retryDecision.shouldRetry && retryDecision.delayMs !== undefined) {
          return intentRepository.recordResult(claimed.tenantId, claimed.id, workerId, {
            status: "PENDING",
            result,
            scheduledFor: new Date(Date.now() + retryDecision.delayMs),
          });
        }

        return intentRepository.recordResult(claimed.tenantId, claimed.id, workerId, { status: "FAILED", result });
      });
    },
  };
}
