import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxAssessmentService } from "../../health/application/mailbox-assessment-service.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import { ConflictError, NotFoundError, PolicyError } from "../../../shared/errors/index.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import { computeWarmupDay } from "../domain/warmup-day.js";
import { computeIdempotencyKey } from "../domain/warmup-execution-intent.js";
import { InvalidWarmupTransitionError, transitionWarmupState, type WarmupCommand, type WarmupState } from "../domain/warmup-state.js";
import type { WarmupDecision } from "../domain/warmup-decision.js";
import type { WarmupExecutionIntent } from "../domain/warmup-execution-intent.js";
import type { WarmupSession } from "../domain/warmup-session.js";
import { decideWarmupExecution } from "./warmup-execution-policy.js";
import type { WarmupDecisionRepository } from "./warmup-decision-repository.js";
import type { WarmupExecutionIntentRepository } from "./warmup-execution-intent-repository.js";
import type { WarmupSessionRepository } from "./warmup-session-repository.js";
import type { WarmupProfileRepository } from "./warmup-profile-repository.js";

const DEFAULT_DECISION_HISTORY_LIMIT = 20;
const MAX_DECISION_HISTORY_LIMIT = 100;
/** How long an uncompleted execution intent remains claimable before the worker must treat it as stale. */
const INTENT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface WarmupOperationResult {
  readonly session: WarmupSession;
  readonly decision?: WarmupDecision;
  readonly intent?: WarmupExecutionIntent;
}

export interface WarmupStatusResult {
  readonly session: WarmupSession;
  readonly latestDecision?: WarmupDecision;
}

export interface WarmupService {
  /** Server-authoritative: fetches a fresh assessment and evaluates eligibility itself — a caller can never supply risk/eligibility/capacity/volume (Stage 8 spec section 28). */
  startWarmup(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupOperationResult>;
  pauseWarmup(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupSession>;
  resumeWarmup(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupOperationResult>;
  stopWarmup(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupSession>;
  getStatus(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupStatusResult>;
  getDecisions(tenantId: TenantId, mailboxId: MailboxId, limit?: number): Promise<WarmupDecision[]>;
}

export interface CreateWarmupServiceDeps {
  readonly mailboxService: MailboxService;
  readonly mailboxAssessmentService: MailboxAssessmentService;
  readonly warmupProfileRepository: WarmupProfileRepository;
  readonly sessionRepository: WarmupSessionRepository;
  readonly decisionRepository: WarmupDecisionRepository;
  readonly intentRepository: WarmupExecutionIntentRepository;
  readonly auditRecorder: AuditEventRecorder;
}

export function createWarmupService(deps: CreateWarmupServiceDeps): WarmupService {
  const { mailboxService, mailboxAssessmentService, warmupProfileRepository, sessionRepository, decisionRepository, intentRepository, auditRecorder } = deps;

  function applyCommand(state: WarmupState, command: WarmupCommand): WarmupState {
    try {
      return transitionWarmupState(state, command);
    } catch (error) {
      if (error instanceof InvalidWarmupTransitionError) {
        throw new PolicyError(error.message);
      }
      throw error;
    }
  }

  async function requireOpenSession(tenantId: TenantId, mailboxId: MailboxId): Promise<WarmupSession> {
    const session = await sessionRepository.findOpenByMailbox(tenantId, mailboxId);
    if (!session) {
      throw new NotFoundError("Open warmup session for mailbox", mailboxId);
    }
    return session;
  }

  /**
   * The single place a fresh decision (and, when warranted, an execution
   * intent) gets computed and persisted — called from `startWarmup` and
   * `resumeWarmup` (Stage 8 spec section 9: only this policy boundary ever
   * decides). `session.state` must already be `ACTIVE` by the time this
   * runs.
   */
  async function evaluateAndCommit(
    tenantId: TenantId,
    mailboxId: MailboxId,
    mailboxEnabled: boolean,
    provider: MailboxProviderType,
    session: WarmupSession,
  ): Promise<WarmupOperationResult> {
    const profile = await warmupProfileRepository.findByMailboxId(tenantId, mailboxId);
    if (!profile) {
      throw new PolicyError("No warmup profile is configured for this mailbox");
    }
    const assessment = await mailboxAssessmentService.getAssessment(tenantId, mailboxId);
    const day = computeWarmupDay(session.startedAt ?? new Date(), new Date());
    const previousTarget = session.currentDay === day ? session.currentDailyTarget : undefined;

    const outcome = decideWarmupExecution({
      sessionState: session.state,
      currentDay: day,
      previousTarget,
      mailboxEnabled,
      health: assessment.health,
      risk: assessment.risk,
      eligibility: assessment.eligibility,
      capacity: assessment.capacity,
      profile: {
        startingDailyVolume: profile.startingDailyVolume,
        targetDailyVolume: profile.targetDailyVolume,
        maximumDailyVolume: profile.maximumDailyVolume,
        rampStrategy: profile.rampStrategy,
        riskTolerance: profile.riskTolerance,
        active: profile.active,
        pauseConditions: profile.pauseConditions,
      },
    });

    const updatedSession = await sessionRepository.recordDailyDecision(tenantId, session.id, day, outcome.target.recommended);

    const decision = await decisionRepository.create({
      tenantId,
      sessionId: session.id,
      mailboxId,
      warmupDay: day,
      decision: outcome.decision,
      reasonCodes: outcome.reasonCodes,
      reasons: outcome.reasons,
      recommendedVolume: outcome.target.recommended,
      maximumVolume: outcome.target.maximum,
      riskLevel: assessment.risk.riskLevel,
      eligibility: assessment.eligibility.decision,
      assessmentId: assessment.id,
      profileSnapshot: {
        targetDailyVolume: profile.targetDailyVolume,
        startingDailyVolume: profile.startingDailyVolume,
        maximumDailyVolume: profile.maximumDailyVolume,
        rampStrategy: profile.rampStrategy,
        riskTolerance: profile.riskTolerance,
        active: profile.active,
        pauseConditions: profile.pauseConditions,
      },
      generatedAt: new Date(),
    });
    await auditRecorder.record({
      tenantId,
      eventType: "WARMUP_DECISION_CREATED",
      actorType: "system",
      metadata: { mailboxId, sessionId: session.id, decisionId: decision.id, decision: decision.decision, warmupDay: day },
    });

    let finalSession = updatedSession;
    if (outcome.decision === "PAUSE" && updatedSession.state === "ACTIVE") {
      // System-initiated, temporary — distinct from a user-requested PAUSE.
      // The session can resume from COOLDOWN via the same RESUME command.
      finalSession = await sessionRepository.transitionState(tenantId, session.id, "ACTIVE", "COOLDOWN");
    }
    if (outcome.decision === "BLOCK" || outcome.decision === "REVIEW" || outcome.decision === "PAUSE") {
      await auditRecorder.record({
        tenantId,
        eventType: "WARMUP_EXECUTION_BLOCKED",
        actorType: "system",
        metadata: { mailboxId, sessionId: session.id, decisionId: decision.id, decision: decision.decision, reasonCodes: decision.reasonCodes },
      });
    }

    let intent: WarmupExecutionIntent | undefined;
    if ((outcome.decision === "PROCEED" || outcome.decision === "REDUCE") && outcome.target.recommended > 0) {
      const committed = await sessionRepository.commitExecutionVolume(tenantId, session.id, day, outcome.target.recommended);
      if (committed) {
        const idempotencyKey = computeIdempotencyKey({ tenantId, sessionId: session.id, warmupDay: day, executionSlot: committed.allocatedSlot });
        intent = await intentRepository.createIfAbsent({
          tenantId,
          sessionId: session.id,
          mailboxId,
          decisionId: decision.id,
          provider,
          warmupDay: day,
          executionSlot: committed.allocatedSlot,
          idempotencyKey,
          volume: outcome.target.recommended,
          expiresAt: new Date(Date.now() + INTENT_EXPIRY_MS),
        });
        await auditRecorder.record({
          tenantId,
          eventType: "WARMUP_INTENT_CREATED",
          actorType: "system",
          metadata: { mailboxId, sessionId: session.id, intentId: intent.id, warmupDay: day, executionSlot: committed.allocatedSlot },
        });
      }
    }

    return { session: finalSession, decision, ...(intent ? { intent } : {}) };
  }

  return {
    async startWarmup(tenantId, mailboxId) {
      const mailbox = await mailboxService.getMailbox(tenantId, mailboxId);
      const profile = await warmupProfileRepository.findByMailboxId(tenantId, mailboxId);
      if (!profile) {
        throw new PolicyError("No warmup profile is configured for this mailbox");
      }
      const existing = await sessionRepository.findOpenByMailbox(tenantId, mailboxId);
      if (existing) {
        throw new ConflictError("Mailbox already has an open warmup session");
      }

      // Fetched once and reused for both the pre-activation eligibility
      // check and the decision computation below — never re-fetched
      // mid-operation, so there is no drift within a single API call.
      const assessment = await mailboxAssessmentService.getAssessment(tenantId, mailboxId);
      if (assessment.eligibility.decision === "NOT_ELIGIBLE" || assessment.eligibility.decision === "REQUIRES_REVIEW") {
        await auditRecorder.record({
          tenantId,
          eventType: "WARMUP_EXECUTION_BLOCKED",
          actorType: "api_key",
          metadata: { mailboxId, reason: assessment.eligibility.decision },
        });
        throw new PolicyError(`Mailbox is not ready to start warmup (${assessment.eligibility.decision})`, {
          details: { reasons: assessment.eligibility.reasons },
        });
      }

      // Stage 7 deliberately left every profile `active: false` at creation
      // — "a profile existing is never itself what starts sending." This is
      // the action that actually flips it: a profile only ever becomes
      // active as a direct, explicit result of a caller successfully
      // starting warmup, never as a side effect of anything else.
      await warmupProfileRepository.setActive(tenantId, mailboxId, true);

      const draft = await sessionRepository.create({ tenantId, mailboxId, profileId: profile.id });
      const activated = await sessionRepository.transitionState(tenantId, draft.id, "DRAFT", "ACTIVE");
      await auditRecorder.record({
        tenantId,
        eventType: "WARMUP_STARTED",
        actorType: "api_key",
        metadata: { mailboxId, sessionId: activated.id },
      });

      return evaluateAndCommit(tenantId, mailboxId, mailbox.enabled, mailbox.provider, activated);
    },

    async pauseWarmup(tenantId, mailboxId) {
      const session = await requireOpenSession(tenantId, mailboxId);
      const toState = applyCommand(session.state, "PAUSE");
      const paused = await sessionRepository.transitionState(tenantId, session.id, session.state, toState);
      await auditRecorder.record({ tenantId, eventType: "WARMUP_PAUSED", actorType: "api_key", metadata: { mailboxId, sessionId: session.id } });
      return paused;
    },

    async resumeWarmup(tenantId, mailboxId) {
      const session = await requireOpenSession(tenantId, mailboxId);
      const toState = applyCommand(session.state, "RESUME");
      const resumed = await sessionRepository.transitionState(tenantId, session.id, session.state, toState);
      await auditRecorder.record({ tenantId, eventType: "WARMUP_RESUMED", actorType: "api_key", metadata: { mailboxId, sessionId: session.id } });

      const mailbox = await mailboxService.getMailbox(tenantId, mailboxId);
      return evaluateAndCommit(tenantId, mailboxId, mailbox.enabled, mailbox.provider, resumed);
    },

    async stopWarmup(tenantId, mailboxId) {
      const session = await requireOpenSession(tenantId, mailboxId);
      const toState = applyCommand(session.state, "STOP");
      const stopped = await sessionRepository.transitionState(tenantId, session.id, session.state, toState);
      // Mirrors startWarmup: stopping is the explicit action that ends the
      // profile's "in use" state, never a side effect the profile itself
      // decides on its own.
      await warmupProfileRepository.setActive(tenantId, mailboxId, false);
      await auditRecorder.record({ tenantId, eventType: "WARMUP_STOPPED", actorType: "api_key", metadata: { mailboxId, sessionId: session.id } });
      return stopped;
    },

    async getStatus(tenantId, mailboxId) {
      await mailboxService.getMailbox(tenantId, mailboxId);
      const session = await sessionRepository.findLatestByMailbox(tenantId, mailboxId);
      if (!session) {
        throw new NotFoundError("Warmup session for mailbox", mailboxId);
      }
      const [latestDecision] = await decisionRepository.listBySession(tenantId, session.id, 1);
      return { session, ...(latestDecision ? { latestDecision } : {}) };
    },

    async getDecisions(tenantId, mailboxId, limit = DEFAULT_DECISION_HISTORY_LIMIT) {
      await mailboxService.getMailbox(tenantId, mailboxId);
      const session = await sessionRepository.findLatestByMailbox(tenantId, mailboxId);
      if (!session) {
        return [];
      }
      const boundedLimit = Math.min(Math.max(1, limit), MAX_DECISION_HISTORY_LIMIT);
      return decisionRepository.listBySession(tenantId, session.id, boundedLimit);
    },
  };
}
