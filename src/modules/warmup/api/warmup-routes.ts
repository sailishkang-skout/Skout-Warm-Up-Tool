import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import { asMailboxId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { WarmupDecision } from "../domain/warmup-decision.js";
import type { WarmupSession } from "../domain/warmup-session.js";
import type { WarmupExecutionIntent } from "../domain/warmup-execution-intent.js";
import type { WarmupOperationResult, WarmupService } from "../application/warmup-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function parseMailboxId(rawId: string): MailboxId {
  if (!UUID_PATTERN.test(rawId)) {
    throw new ValidationError("Invalid mailbox id");
  }
  return asMailboxId(rawId);
}

const decisionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function toSafeSessionResponse(session: WarmupSession) {
  return {
    id: session.id,
    mailboxId: session.mailboxId,
    profileId: session.profileId,
    state: session.state,
    currentDay: session.currentDay,
    currentDailyTarget: session.currentDailyTarget,
    committedVolumeToday: session.committedVolumeToday,
    ...(session.startedAt ? { startedAt: session.startedAt.toISOString() } : {}),
    ...(session.pausedAt ? { pausedAt: session.pausedAt.toISOString() } : {}),
    ...(session.completedAt ? { completedAt: session.completedAt.toISOString() } : {}),
    ...(session.stoppedAt ? { stoppedAt: session.stoppedAt.toISOString() } : {}),
    ...(session.lastDecisionAt ? { lastDecisionAt: session.lastDecisionAt.toISOString() } : {}),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function toSafeDecisionResponse(decision: WarmupDecision) {
  return {
    id: decision.id,
    sessionId: decision.sessionId,
    warmupDay: decision.warmupDay,
    decision: decision.decision,
    reasonCodes: decision.reasonCodes,
    reasons: decision.reasons,
    recommendedVolume: decision.recommendedVolume,
    maximumVolume: decision.maximumVolume,
    riskLevel: decision.riskLevel,
    eligibility: decision.eligibility,
    generatedAt: decision.generatedAt.toISOString(),
  };
}

function toSafeIntentResponse(intent: WarmupExecutionIntent) {
  return {
    id: intent.id,
    status: intent.status,
    warmupDay: intent.warmupDay,
    volume: intent.volume,
    createdAt: intent.createdAt.toISOString(),
  };
}

function toSafeOperationResponse(result: WarmupOperationResult) {
  return {
    session: toSafeSessionResponse(result.session),
    ...(result.decision ? { decision: toSafeDecisionResponse(result.decision) } : {}),
    ...(result.intent ? { intent: toSafeIntentResponse(result.intent) } : {}),
  };
}

/**
 * Registered under /api/v1/mailboxes. Every route requires authentication.
 * Deliberately accepts no request body on any of these routes — risk,
 * eligibility, capacity, and volume are always server-authoritative,
 * computed fresh from `health`/`risk`/`policy` inside `WarmupService`
 * (Stage 8 spec section 28: "Do not allow a client to provide risk level /
 * eligibility / capacity / recommended volume").
 */
export function warmupRoutes(warmupService: WarmupService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.post<{ Params: { id: string } }>("/:id/warmup", { preHandler: fastify.authenticate }, async (request, reply) => {
      const tenantId = requireTenantId(request);
      const result = await warmupService.startWarmup(tenantId, parseMailboxId(request.params.id));
      reply.status(201);
      return toSafeOperationResponse(result);
    });

    fastify.get<{ Params: { id: string } }>("/:id/warmup", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const status = await warmupService.getStatus(tenantId, parseMailboxId(request.params.id));
      return {
        session: toSafeSessionResponse(status.session),
        ...(status.latestDecision ? { latestDecision: toSafeDecisionResponse(status.latestDecision) } : {}),
      };
    });

    fastify.post<{ Params: { id: string } }>("/:id/warmup/pause", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const session = await warmupService.pauseWarmup(tenantId, parseMailboxId(request.params.id));
      return { session: toSafeSessionResponse(session) };
    });

    fastify.post<{ Params: { id: string } }>("/:id/warmup/resume", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const result = await warmupService.resumeWarmup(tenantId, parseMailboxId(request.params.id));
      return toSafeOperationResponse(result);
    });

    fastify.post<{ Params: { id: string } }>("/:id/warmup/stop", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const session = await warmupService.stopWarmup(tenantId, parseMailboxId(request.params.id));
      return { session: toSafeSessionResponse(session) };
    });

    fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
      "/:id/warmup/decisions",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailboxId = parseMailboxId(request.params.id);
        const parsed = decisionsQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          throw new ValidationError("Invalid decisions query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
        }
        const decisions = await warmupService.getDecisions(tenantId, mailboxId, parsed.data.limit);
        return { mailboxId, decisions: decisions.map(toSafeDecisionResponse) };
      },
    );
  };
}
