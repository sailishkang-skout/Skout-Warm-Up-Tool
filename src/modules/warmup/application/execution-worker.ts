import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxAssessmentService } from "../../health/application/mailbox-assessment-service.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import { classifyRetry } from "../domain/retry-policy.js";
import type { WarmupExecutionIntent } from "../domain/warmup-execution-intent.js";
import { evaluateSafetyGate } from "./safety-gate.js";
import type { WarmupExecutionIntentRepository } from "./warmup-execution-intent-repository.js";
import type { WarmupProfileRepository } from "./warmup-profile-repository.js";
import type { WarmupSendProvider } from "./warmup-send-provider.js";
import type { WarmupSessionRepository } from "./warmup-session-repository.js";

const LEASE_DURATION_MS = 60_000;

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
}

export function createExecutionWorker(deps: CreateExecutionWorkerDeps): ExecutionWorker {
  const { intentRepository, sessionRepository, warmupProfileRepository, mailboxService, mailboxAssessmentService, sendProvider, auditRecorder } = deps;

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

  return {
    async processNext(workerId: string): Promise<WarmupExecutionIntent | undefined> {
      const claimed = await intentRepository.claimNext(workerId, LEASE_DURATION_MS);
      if (!claimed) {
        return undefined;
      }
      await auditRecorder.record({
        tenantId: claimed.tenantId,
        eventType: "WARMUP_INTENT_CLAIMED",
        actorType: "system",
        metadata: { mailboxId: claimed.mailboxId, sessionId: claimed.sessionId, intentId: claimed.id, attemptCount: claimed.attemptCount },
      });

      // Stale decision protection (Stage 8 spec section 17): everything
      // that justified this intent when it was created is re-fetched fresh
      // here, never trusted from the (possibly now-stale) decision that
      // created it. "It was valid when scheduled" is never sufficient.
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
      // confirmed, so this can NEVER be treated as retryable. A retry here
      // risks sending a genuine duplicate, since neither Gmail nor
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
    },
  };
}
