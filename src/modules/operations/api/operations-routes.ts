import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import type { TenantId } from "../../../shared/types/index.js";
import type { KillSwitchService } from "../application/kill-switch-service.js";

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

const activateBody = z.object({
  scope: z.enum(["GLOBAL", "PROVIDER", "NETWORK", "TENANT", "DOMAIN", "MAILBOX"]),
  scopeId: z.string().max(200).optional(),
  reason: z.string().trim().min(3).max(500),
});

export function operationsRoutes(service: KillSwitchService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.addHook("preHandler", fastify.authenticate);

    fastify.get("/kill-switches", async (request) => {
      requireTenantId(request);
      const switches = await service.listActive();
      return {
        switches: switches.map((item) => ({
          id: item.id,
          scope: item.scope,
          scopeId: item.scopeId,
          status: item.status,
          reason: item.reason,
          createdAt: item.createdAt.toISOString(),
        })),
      };
    });

    fastify.post("/kill-switches", async (request) => {
      requireTenantId(request);
      const parsed = activateBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid kill switch payload");
      }
      const created = await service.activate(parsed.data.scope, parsed.data.scopeId ?? "", parsed.data.reason);
      return {
        switch: {
          id: created.id,
          scope: created.scope,
          scopeId: created.scopeId,
          status: created.status,
          reason: created.reason,
        },
      };
    });
  };
}
