import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import { NotFoundError, PolicyError } from "../../../shared/errors/index.js";
import type { MailboxId, TenantId, WarmupExecutionIntentId } from "../../../shared/types/index.js";
import type { ExecutionIntentStatus } from "../domain/warmup-execution-intent.js";
import type { WarmupExecutionIntentRepository } from "./warmup-execution-intent-repository.js";

/**
 * Everything a human needs to go check the mailbox's actual sent history —
 * nothing more. `lastResult?.safeReason` is already scrubbed of provider
 * bodies/tokens by contract (see `domain/send-result.ts`); no other field
 * of the underlying intent (lease, decision id, etc.) is exposed here.
 */
export interface ReconciliationResult {
  readonly intentId: WarmupExecutionIntentId;
  readonly mailboxId: MailboxId;
  readonly status: ExecutionIntentStatus;
  readonly warmupDay: number;
  readonly volume: number;
  readonly safeReason?: string;
}

export interface WarmupReconciliationService {
  /**
   * The minimum safe foundation for reconciling a `SEND_UNKNOWN` intent
   * (hardening spec Gap A):
   *
   *   SEND_UNKNOWN → REQUIRES_RECONCILIATION → human/provider-specific
   *   reconciliation → explicit final decision
   *
   * This function only performs the first arrow. It never calls
   * `WarmupSendProvider.sendWarmupMessage` (so it can never send a
   * duplicate), never marks the intent `SENT` on its own recognizance, and
   * never automatically retries — it just records, durably and audibly,
   * that reconciliation has been requested. Idempotent: calling it twice
   * for the same intent is always safe and returns the same result.
   */
  reconcileUnknownExecution(tenantId: TenantId, intentId: WarmupExecutionIntentId): Promise<ReconciliationResult>;
}

export interface CreateWarmupReconciliationServiceDeps {
  readonly intentRepository: WarmupExecutionIntentRepository;
  readonly auditRecorder: AuditEventRecorder;
}

export function createWarmupReconciliationService(deps: CreateWarmupReconciliationServiceDeps): WarmupReconciliationService {
  const { intentRepository, auditRecorder } = deps;

  return {
    async reconcileUnknownExecution(tenantId: TenantId, intentId: WarmupExecutionIntentId): Promise<ReconciliationResult> {
      const intent = await intentRepository.findById(tenantId, intentId);
      if (!intent) {
        throw new NotFoundError("Warmup execution intent", intentId);
      }
      if (intent.status !== "SEND_UNKNOWN" && intent.status !== "REQUIRES_RECONCILIATION") {
        throw new PolicyError(
          `Execution intent is not eligible for reconciliation (status is ${intent.status}) — reconciliation only applies to an unconfirmed (SEND_UNKNOWN) send`,
        );
      }

      const alreadyRequested = intent.status === "REQUIRES_RECONCILIATION";
      const updated = await intentRepository.markRequiresReconciliation(tenantId, intentId);

      // Auditable (Gap A requirement 8), but only on the actual transition
      // — a repeated idempotent call does not spam the audit log with
      // identical "requested" events for a request that already happened.
      if (!alreadyRequested) {
        await auditRecorder.record({
          tenantId,
          eventType: "WARMUP_RECONCILIATION_REQUESTED",
          actorType: "api_key",
          metadata: { mailboxId: updated.mailboxId, sessionId: updated.sessionId, intentId: updated.id, warmupDay: updated.warmupDay },
        });
      }

      return {
        intentId: updated.id,
        mailboxId: updated.mailboxId,
        status: updated.status,
        warmupDay: updated.warmupDay,
        volume: updated.volume,
        ...(updated.lastResult?.safeReason ? { safeReason: updated.lastResult.safeReason } : {}),
      };
    },
  };
}
