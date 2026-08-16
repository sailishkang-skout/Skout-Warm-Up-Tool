import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import { asMailboxId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { MailboxAssessmentService } from "../application/mailbox-assessment-service.js";
import type { AssessmentSnapshot } from "../domain/assessment-snapshot.js";

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

function toSafeSnapshotResponse(snapshot: AssessmentSnapshot) {
  return {
    mailboxId: snapshot.mailboxId,
    assessedAt: snapshot.assessedAt.toISOString(),
    health: { ...snapshot.health, assessedAt: snapshot.health.assessedAt.toISOString() },
    risk: { ...snapshot.risk, assessedAt: snapshot.risk.assessedAt.toISOString() },
    eligibility: { ...snapshot.eligibility, assessedAt: snapshot.eligibility.assessedAt.toISOString() },
    capacity: { ...snapshot.capacity, assessedAt: snapshot.capacity.assessedAt.toISOString() },
    ...(snapshot.domainAssessment
      ? { domain: { ...snapshot.domainAssessment, checkedAt: snapshot.domainAssessment.checkedAt.toISOString() } }
      : {}),
  };
}

/**
 * Registered under /api/v1/mailboxes. Every route requires authentication —
 * this is intelligence *about* a tenant's own mailbox, never public. See
 * ../README.md for the health/risk/eligibility/capacity pipeline these
 * routes expose read-only views onto; none of them make a decision
 * themselves, they only report health/risk/policy's output. Kept as a
 * single facade (rather than split per-module routers) so the API contract
 * established in Stage 7 doesn't change as part of the module-boundary
 * refactor.
 */
export function mailboxAssessmentRoutes(mailboxAssessmentService: MailboxAssessmentService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get<{ Params: { id: string } }>(
      "/:id/intelligence",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const snapshot = await mailboxAssessmentService.getAssessment(tenantId, parseMailboxId(request.params.id));
        return toSafeSnapshotResponse(snapshot);
      },
    );

    fastify.get<{ Params: { id: string } }>("/:id/risk", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const snapshot = await mailboxAssessmentService.getAssessment(tenantId, parseMailboxId(request.params.id));
      return { mailboxId: snapshot.mailboxId, ...snapshot.risk, assessedAt: snapshot.risk.assessedAt.toISOString() };
    });

    fastify.get<{ Params: { id: string } }>(
      "/:id/eligibility",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const snapshot = await mailboxAssessmentService.getAssessment(tenantId, parseMailboxId(request.params.id));
        return {
          mailboxId: snapshot.mailboxId,
          ...snapshot.eligibility,
          assessedAt: snapshot.eligibility.assessedAt.toISOString(),
        };
      },
    );

    fastify.get<{ Params: { id: string } }>(
      "/:id/capacity",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const snapshot = await mailboxAssessmentService.getAssessment(tenantId, parseMailboxId(request.params.id));
        return {
          mailboxId: snapshot.mailboxId,
          ...snapshot.capacity,
          assessedAt: snapshot.capacity.assessedAt.toISOString(),
        };
      },
    );

    fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
      "/:id/intelligence/history",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailboxId = parseMailboxId(request.params.id);
        const parsed = historyQuerySchema.safeParse(request.query);
        if (!parsed.success) {
          throw new ValidationError("Invalid history query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
        }
        const history = await mailboxAssessmentService.getHistory(tenantId, mailboxId, parsed.data.limit);
        return { mailboxId, history: history.map(toSafeSnapshotResponse) };
      },
    );

    fastify.post<{ Params: { id: string } }>(
      "/:id/intelligence/refresh",
      { preHandler: fastify.authenticate },
      async (request, reply) => {
        const tenantId = requireTenantId(request);
        const snapshot = await mailboxAssessmentService.refreshAssessment(tenantId, parseMailboxId(request.params.id));
        reply.status(202);
        return toSafeSnapshotResponse(snapshot);
      },
    );
  };
}
