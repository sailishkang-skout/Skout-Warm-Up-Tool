import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import type { TenantId } from "../../../shared/types/index.js";
import type { MailboxProvisioningService } from "../application/mailbox-provisioning-service.js";

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

const bodySchema = z.object({
  emailAddress: z.string().trim().min(3).max(320),
  provider: z.enum(["GMAIL", "MICROSOFT365"]),
  customerDomainId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export function mailboxProvisioningRoutes(service: MailboxProvisioningService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.addHook("preHandler", fastify.authenticate);

    fastify.post("/provision", async (request) => {
      const tenantId = requireTenantId(request);
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid mailbox provision payload");
      }
      const result = await service.provision({
        tenantId,
        emailAddress: parsed.data.emailAddress,
        provider: parsed.data.provider,
        idempotencyKey: parsed.data.idempotencyKey,
        ...(parsed.data.customerDomainId ? { customerDomainId: parsed.data.customerDomainId } : {}),
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      });
      return result;
    });
  };
}
