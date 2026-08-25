import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ApiCredentialService } from "../application/api-credential-service.js";
import type { TenantRepository } from "../../tenancy/application/tenant-repository.js";
import { AuthenticationError, ConfigurationError, ValidationError } from "../../../shared/errors/index.js";

const provisionBodySchema = z.object({
  tenantName: z.string().trim().min(1).max(200),
  credentialName: z.string().trim().min(1).max(200).default("Skout workspace credential"),
  /** Optional opaque correlation id from the calling platform (e.g. Skout workspaceId). */
  externalRef: z.string().trim().min(1).max(200).optional(),
});

function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Platform-only tenant bootstrap for Skout main API.
 * Auth: `Authorization: Bearer <PLATFORM_PROVISIONING_KEY>` (not a swu_ tenant key).
 * Registered under `/api/v1/internal`.
 */
export function platformProvisionRoutes(deps: {
  readonly tenantRepository: TenantRepository;
  readonly credentialService: ApiCredentialService;
  readonly platformProvisioningKey: string | undefined;
}): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.post("/provision-tenant", async (request, reply) => {
      const expected = deps.platformProvisioningKey;
      if (!expected) {
        throw new ConfigurationError(
          "PLATFORM_PROVISIONING_KEY is not configured; tenant provisioning is disabled",
        );
      }

      const header = request.headers.authorization;
      const token =
        header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
      if (!token || !safeEqualString(token, expected)) {
        throw new AuthenticationError("Invalid or missing platform provisioning credentials");
      }

      const parsed = provisionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid provision-tenant payload", {
          fieldErrors: z.flattenError(parsed.error).fieldErrors,
        });
      }

      const tenantName = parsed.data.externalRef
        ? `${parsed.data.tenantName} [${parsed.data.externalRef}]`
        : parsed.data.tenantName;

      const tenant = await deps.tenantRepository.create({ name: tenantName });
      const issued = await deps.credentialService.issueCredential(tenant.id, {
        name: parsed.data.credentialName,
      });

      reply.status(201);
      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          status: tenant.status,
          createdAt: tenant.createdAt.toISOString(),
        },
        credential: {
          id: issued.credential.id,
          name: issued.credential.name,
          prefix: issued.credential.keyPrefix,
          status: issued.credential.status,
        },
        apiKey: issued.apiKey,
        warning: "This is the only time the full API key will be shown. Store it securely now.",
      };
    });
  };
}
