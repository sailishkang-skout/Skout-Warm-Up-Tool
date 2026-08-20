import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import type { TenantId } from "../../../shared/types/index.js";
import type { OrganizationProviderAccountService } from "../application/organization-provider-account-service.js";
import type { OrganizationProviderAccount } from "../domain/organization-provider-account.js";

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function toSafe(account: OrganizationProviderAccount) {
  return {
    id: account.id,
    provider: account.provider,
    customerDomain: account.customerDomain,
    status: account.status,
    ...(account.providerCustomerId ? { providerCustomerId: account.providerCustomerId } : {}),
    ...(account.customerDomainId ? { customerDomainId: account.customerDomainId } : {}),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

const createBody = z.object({
  provider: z.enum(["GMAIL", "MICROSOFT365"]),
  customerDomain: z.string().trim().min(3).max(255),
  customerDomainId: z.string().uuid().optional(),
});

export function organizationProviderAccountRoutes(service: OrganizationProviderAccountService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.addHook("preHandler", fastify.authenticate);

    fastify.post("/", async (request) => {
      const tenantId = requireTenantId(request);
      const parsed = createBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid provider account payload");
      }
      const account = await service.create(tenantId, {
        provider: parsed.data.provider,
        customerDomain: parsed.data.customerDomain,
        ...(parsed.data.customerDomainId ? { customerDomainId: parsed.data.customerDomainId } : {}),
      });
      return { providerAccount: toSafe(account) };
    });

    fastify.get("/", async (request) => {
      const tenantId = requireTenantId(request);
      const accounts = await service.list(tenantId);
      return { providerAccounts: accounts.map(toSafe) };
    });

    fastify.get("/:id", async (request) => {
      const tenantId = requireTenantId(request);
      const id = (request.params as { id: string }).id;
      const account = await service.get(tenantId, id);
      return { providerAccount: toSafe(account) };
    });
  };
}
