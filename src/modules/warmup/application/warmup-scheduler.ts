import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { Logger } from "../../../shared/logger/index.js";
import { computeWarmupDay } from "../domain/warmup-day.js";
import type { ExecutionWorker } from "./execution-worker.js";
import type { WarmupService } from "./warmup-service.js";
import type { WarmupExecutionIntentRepository } from "./warmup-execution-intent-repository.js";
import type { WarmupSessionRepository } from "./warmup-session-repository.js";

const DUE_SESSION_BATCH_LIMIT = 100;
const LEASE_RECLAIM_BATCH_LIMIT = 100;

export interface WarmupSchedulerTickResult {
  readonly reclaimedLeases: number;
  readonly dueSessionsFound: number;
  readonly sessionsAdvanced: number;
  readonly intentsProcessed: number;
}

/**
 * The Stage 12 orchestration boundary: answers "when," never "is it safe."
 * Every one of its three responsibilities delegates to already-existing,
 * already-tested logic — `WarmupExecutionIntentRepository.reclaimExpiredLeases`,
 * `WarmupService.advanceDailyWarmup` (which reuses `evaluateAndCommit`, the
 * one policy boundary that has always decided this), and
 * `ExecutionWorker.processNext` (unmodified — still the sole thing that
 * ever calls `WarmupSendProvider.sendWarmupMessage`). This file contains no
 * risk/reputation/safety-gate/execution-policy logic of its own, and never
 * imports a `ProviderAdapter`.
 */
export interface WarmupScheduler {
  /**
   * One full pass: reclaim → advance due sessions → drain pending intents
   * (Stage 12 spec's "WORKER LOOP" pseudocode, exactly). Never throws for a
   * single mailbox's failure — errors advancing one due session are logged
   * and skipped so one bad mailbox can never block every other tenant's
   * warmup from progressing in the same tick. A failure in the
   * reclaim/drain steps themselves is allowed to propagate — the caller
   * (`src/workers/execution-worker-process.ts`) catches per-tick and
   * continues on the next poll.
   */
  runTick(workerId: string): Promise<WarmupSchedulerTickResult>;
}

export interface CreateWarmupSchedulerDeps {
  readonly warmupService: WarmupService;
  readonly sessionRepository: WarmupSessionRepository;
  readonly intentRepository: WarmupExecutionIntentRepository;
  readonly executionWorker: ExecutionWorker;
  readonly auditRecorder: AuditEventRecorder;
  readonly logger: Logger;
}

export function createWarmupScheduler(deps: CreateWarmupSchedulerDeps): WarmupScheduler {
  const { warmupService, sessionRepository, intentRepository, executionWorker, auditRecorder, logger } = deps;

  return {
    async runTick(workerId: string): Promise<WarmupSchedulerTickResult> {
      const now = new Date();

      // 1. Reclaim expired leases first — a crashed worker's stuck intent
      // becomes available again before this same tick looks for due
      // sessions or starts draining, so it can be picked back up promptly.
      const reclaimed = await intentRepository.reclaimExpiredLeases(now, LEASE_RECLAIM_BATCH_LIMIT);
      for (const intent of reclaimed) {
        await auditRecorder.record({
          tenantId: intent.tenantId,
          eventType: "WARMUP_INTENT_LEASE_RECLAIMED",
          actorType: "system",
          metadata: { mailboxId: intent.mailboxId, sessionId: intent.sessionId, intentId: intent.id, attemptCount: intent.attemptCount, newStatus: intent.newStatus },
        });
      }
      if (reclaimed.length > 0) {
        logger.warn({ count: reclaimed.length }, "Reclaimed expired execution-intent leases");
      }

      // 2. Advance sessions whose warmup day has genuinely advanced. The
      // repository query is a cheap pre-filter (last_decision_at before
      // today's UTC midnight); `computeWarmupDay` — the one authoritative,
      // never-duplicated domain calculation — decides for real per
      // candidate before anything is committed.
      const todayUtcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const candidates = await sessionRepository.findActiveSessionsDueForDecision(todayUtcMidnight, DUE_SESSION_BATCH_LIMIT);
      let sessionsAdvanced = 0;
      for (const session of candidates) {
        const day = computeWarmupDay(session.startedAt ?? now, now);
        if (day <= session.currentDay) {
          continue;
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          await warmupService.advanceDailyWarmup(session.tenantId, session.mailboxId);
          sessionsAdvanced += 1;
        } catch (err) {
          logger.error(
            { err, tenantId: session.tenantId, mailboxId: session.mailboxId, sessionId: session.id },
            "Failed to advance daily warmup for a due session — will retry on the next tick",
          );
        }
      }
      if (candidates.length > 0) {
        logger.info({ dueSessionsFound: candidates.length, sessionsAdvanced }, "Processed due warmup sessions");
      }

      // 3. Drain every currently-claimable intent — `processNext` already
      // is, and remains, the only thing that ever calls
      // `WarmupSendProvider.sendWarmupMessage`; this loop only decides
      // *when* to call it again, never whether a send is safe.
      let intentsProcessed = 0;
      let processed = await executionWorker.processNext(workerId);
      while (processed) {
        intentsProcessed += 1;
        // eslint-disable-next-line no-await-in-loop
        processed = await executionWorker.processNext(workerId);
      }
      if (intentsProcessed > 0) {
        logger.info({ intentsProcessed }, "Drained warmup execution intents");
      }

      return { reclaimedLeases: reclaimed.length, dueSessionsFound: candidates.length, sessionsAdvanced, intentsProcessed };
    },
  };
}
