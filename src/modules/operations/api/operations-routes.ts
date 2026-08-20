import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import type { TenantId } from "../../../shared/types/index.js";
import type { KillSwitchService } from "../application/kill-switch-service.js";
import type { QuarantineService } from "../application/quarantine-service.js";

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function isOperator(request: FastifyRequest): boolean {
  return request.ctx.actor?.type === "api_key" && request.ctx.actor.privilege === "OPERATOR";
}

const activateBody = z.object({
  scope: z.enum(["GLOBAL", "PROVIDER", "NETWORK", "TENANT", "DOMAIN", "MAILBOX"]),
  scopeId: z.string().max(200).optional(),
  reason: z.string().trim().min(3).max(500),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const quarantineBody = z.object({
  scope: z.enum(["MAILBOX", "DOMAIN", "PROVIDER_ACCOUNT", "NETWORK"]),
  scopeId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(3).max(500),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const FLEET_SCOPES = new Set(["GLOBAL", "PROVIDER", "NETWORK"]);

export function operationsRoutes(service: KillSwitchService, quarantineService: QuarantineService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.addHook("preHandler", fastify.authenticate);

    fastify.get("/kill-switches", async (request) => {
      const tenantId = requireTenantId(request);
      const switches = await service.listActive();
      const visible = isOperator(request)
        ? switches
        : switches.filter((item) => !FLEET_SCOPES.has(item.scope) && (item.scope !== "TENANT" || item.scopeId === tenantId));
      return {
        switches: visible.map((item) => ({
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
      const tenantId = requireTenantId(request);
      const parsed = activateBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid kill switch payload");
      }
      if (FLEET_SCOPES.has(parsed.data.scope) && !isOperator(request)) {
        throw new AuthorizationError("Fleet kill switches require operator authorization");
      }
      if (parsed.data.scope === "TENANT" && parsed.data.scopeId && parsed.data.scopeId !== tenantId && !isOperator(request)) {
        throw new AuthorizationError("Tenants may only toggle their own tenant kill switch");
      }
      const scopeId =
        parsed.data.scope === "TENANT" ? (parsed.data.scopeId && isOperator(request) ? parsed.data.scopeId : tenantId) : (parsed.data.scopeId ?? "");
      if (parsed.data.status === "INACTIVE") {
        const updated = await service.deactivate(parsed.data.scope, scopeId, parsed.data.reason);
        return { switch: updated };
      }
      const created = await service.activate(parsed.data.scope, scopeId, parsed.data.reason);
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

    fastify.get("/quarantines", async (request) => {
      requireTenantId(request);
      if (!isOperator(request)) {
        throw new AuthorizationError("Quarantine listing requires operator authorization");
      }
      const items = await quarantineService.listActive();
      return {
        quarantines: items.map((item) => ({
          id: item.id,
          scope: item.scope,
          scopeId: item.scopeId,
          status: item.status,
          reason: item.reason,
        })),
      };
    });

    fastify.post("/quarantines", async (request) => {
      const tenantId = requireTenantId(request);
      const parsed = quarantineBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid quarantine payload");
      }
      if (parsed.data.scope === "NETWORK" && !isOperator(request)) {
        throw new AuthorizationError("Network quarantine requires operator authorization");
      }
      if (parsed.data.status === "INACTIVE") {
        const updated = await quarantineService.deactivate(parsed.data.scope, parsed.data.scopeId, parsed.data.reason);
        return { quarantine: updated };
      }
      const created = await quarantineService.activate(parsed.data.scope, parsed.data.scopeId, parsed.data.reason, tenantId);
      return { quarantine: created };
    });
  };
}
