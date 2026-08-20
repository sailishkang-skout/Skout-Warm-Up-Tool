import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import type { TenantId } from "../../../shared/types/index.js";
import type { CustomerDomainService } from "../application/customer-domain-service.js";
import type { CustomerDomain } from "../domain/customer-domain.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function toSafe(domain: CustomerDomain) {
  return {
    id: domain.id,
    domainName: domain.domainName,
    status: domain.status,
    verificationStatus: domain.verificationStatus,
    provider: domain.provider,
    dnsStatus: domain.dnsStatus,
    spfStatus: domain.spfStatus,
    dkimStatus: domain.dkimStatus,
    dmarcStatus: domain.dmarcStatus,
    mxStatus: domain.mxStatus,
    createdAt: domain.createdAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
  };
}

const createBody = z.object({
  domainName: z.string().trim().min(3).max(255),
  provider: z.enum(["GMAIL", "MICROSOFT365", "UNKNOWN"]).optional(),
});

const dnsBody = z.object({
  mx: z.enum(["PASS", "FAIL", "MISSING", "UNKNOWN", "ERROR"]),
  spf: z.enum(["PASS", "FAIL", "MISSING", "UNKNOWN", "ERROR"]),
  dkim: z.enum(["PASS", "FAIL", "MISSING", "UNKNOWN", "ERROR"]),
  dmarc: z.enum(["PASS", "FAIL", "MISSING", "UNKNOWN", "ERROR"]),
});

export function customerDomainRoutes(service: CustomerDomainService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.addHook("preHandler", fastify.authenticate);

    fastify.post("/", async (request) => {
      const tenantId = requireTenantId(request);
      const parsed = createBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid domain create payload");
      }
      const domain = await service.create(tenantId, parsed.data.domainName, parsed.data.provider);
      return { domain: toSafe(domain) };
    });

    fastify.get("/", async (request) => {
      const tenantId = requireTenantId(request);
      const domains = await service.list(tenantId);
      return { domains: domains.map(toSafe) };
    });

    fastify.get("/:id", async (request) => {
      const tenantId = requireTenantId(request);
      const id = (request.params as { id: string }).id;
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError("Invalid domain id");
      }
      const domain = await service.get(tenantId, id);
      return { domain: toSafe(domain) };
    });

    fastify.post("/:id/verify", async (request) => {
      const tenantId = requireTenantId(request);
      const id = (request.params as { id: string }).id;
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError("Invalid domain id");
      }
      const parsed = dnsBody.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("DNS evidence is required; verification is never assumed");
      }
      const domain = await service.applyDnsEvidence(tenantId, id, parsed.data);
      return { domain: toSafe(domain) };
    });
  };
}
