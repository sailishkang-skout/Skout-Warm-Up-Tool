import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { AuthorizationError, NotFoundError, ValidationError } from "../../../shared/errors/index.js";
import { asMailboxId, asWarmupExecutionIntentId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { ReconciliationResult, WarmupReconciliationService } from "../application/warmup-reconciliation-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function parseUuidParam(rawId: string, label: string): string {
  if (!UUID_PATTERN.test(rawId)) {
    throw new ValidationError(`Invalid ${label}`);
  }
  return rawId;
}

function toSafeReconciliationResponse(result: ReconciliationResult) {
  return {
    intentId: result.intentId,
    mailboxId: result.mailboxId,
    status: result.status,
    warmupDay: result.warmupDay,
    volume: result.volume,
    ...(result.safeReason ? { safeReason: result.safeReason } : {}),
  };
}

/**
 * Registered under /api/v1/mailboxes — administrative/internal by nature
 * (hardening spec Gap A section 11: "keep it administrative/internal and
 * authenticated"), not part of the normal warmup lifecycle a caller drives.
 * Every route requires the same tenant authentication every other warmup
 * route does; there is no separate admin credential tier in this service
 * yet, so tenant-scoped authentication is the enforcement boundary here —
 * same as everywhere else in this codebase.
 *
 * Deliberately a single action with no request body: the only input is
 * which intent to reconcile. This never sends anything and never marks an
 * intent SENT — see `application/warmup-reconciliation-service.ts`. The
 * mailbox id in the path is a defense-in-depth check, not the isolation
 * boundary (tenant scoping in the service already fully enforces that) —
 * it just keeps the URL consistent with every other warmup route and
 * rejects a request whose path mailbox doesn't match the intent's actual
 * mailbox rather than silently ignoring the mismatch.
 */
export function warmupReconciliationRoutes(reconciliationService: WarmupReconciliationService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.post<{ Params: { id: string; intentId: string } }>(
      "/:id/warmup/executions/:intentId/reconcile",
      { preHandler: fastify.authenticate },
      async (request, reply) => {
        const tenantId = requireTenantId(request);
        const mailboxId: MailboxId = asMailboxId(parseUuidParam(request.params.id, "mailbox id"));
        const intentId = asWarmupExecutionIntentId(parseUuidParam(request.params.intentId, "execution intent id"));

        const result = await reconciliationService.reconcileUnknownExecution(tenantId, intentId);
        if (result.mailboxId !== mailboxId) {
          throw new NotFoundError("Warmup execution intent", intentId);
        }

        reply.status(200);
        return toSafeReconciliationResponse(result);
      },
    );
  };
}
