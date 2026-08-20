import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, NotFoundError, ValidationError } from "../../../shared/errors/index.js";
import { asMailboxId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { ReputationService } from "../application/reputation-service.js";
import type { ReputationAssessment } from "../domain/reputation-assessment.js";

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

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Deliberately exposes the full structured assessment (all three windows,
 * every rate, trends, factors) — Stage 10 spec section 19's example
 * response is illustrative, not exhaustive ("such as"). Never exposes the
 * internal threshold constants `application/reputation-policy.ts` uses to
 * derive `status`/`factors` from these rates — only the derived output.
 */
function toSafeReputationResponse(assessment: ReputationAssessment) {
  return {
    mailboxId: assessment.mailboxId,
    status: assessment.status,
    confidence: assessment.confidence,
    factors: assessment.factors,
    trends: assessment.trends,
    last24h: assessment.last24h,
    last7d: assessment.last7d,
    lifetime: assessment.lifetime,
    // Stage 11: visibility into the provider/domain-scoped evidence that
    // also feeds this mailbox's risk assessment (see risk/README.md) — the
    // same derived-output-only rule applies: full structured evidence, but
    // never the internal threshold constants that produced it.
    providerReputation: assessment.providerReputation,
    domainReputation: assessment.domainReputation,
    assessedAt: assessment.assessedAt.toISOString(),
  };
}

/**
 * Registered under /api/v1/mailboxes. Every route requires authentication
 * — this is intelligence about a tenant's own mailbox, never public
 * (Stage 10 spec section 19/22). Read-only: nothing here ever triggers a
 * new assessment computation — that only ever happens as part of
 * `health`'s own assessment refresh (see `../README.md`).
 */
export function reputationRoutes(reputationService: ReputationService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get<{ Params: { id: string } }>("/:id/reputation", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const mailboxId = parseMailboxId(request.params.id);
      const latest = await reputationService.getLatest(tenantId, mailboxId);
      if (!latest) {
        throw new NotFoundError("Reputation assessment for mailbox", mailboxId);
      }
      return toSafeReputationResponse(latest);
    });

    fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
      "/:id/reputation/history",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailboxId = parseMailboxId(request.params.id);
        const parsed = historyQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          throw new ValidationError("Invalid history query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
        }
        const history = await reputationService.getHistory(tenantId, mailboxId, parsed.data.limit);
        return { mailboxId, history: history.map(toSafeReputationResponse) };
      },
    );
  };
}
