import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import { asApiCredentialId, type ApiCredentialId, type TenantId } from "../../../shared/types/index.js";
import type { ApiCredentialService, AuditActorContext } from "../application/api-credential-service.js";
import type { ApiCredential } from "../domain/api-credential.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createCredentialBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  expiresAt: z.iso.datetime().optional(),
});

/**
 * `request.ctx.tenantId` is only ever populated by the authentication
 * plugin from a verified credential — never from the request body, params,
 * or query. This helper exists purely so every handler below reads it the
 * same way instead of each reimplementing the guard.
 */
function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function auditContextFrom(request: FastifyRequest): AuditActorContext {
  return {
    ...(request.ctx.actor ? { actorId: request.ctx.actor.credentialId } : {}),
    requestId: request.ctx.requestId,
    correlationId: request.ctx.correlationId,
  };
}

function parseCredentialId(rawId: string): ApiCredentialId {
  if (!UUID_PATTERN.test(rawId)) {
    throw new ValidationError("Invalid credential id");
  }
  return asApiCredentialId(rawId);
}

function toSafeCredentialResponse(credential: ApiCredential) {
  return {
    id: credential.id,
    name: credential.name,
    prefix: credential.keyPrefix,
    privilege: credential.privilege,
    status: credential.status,
    expiresAt: credential.expiresAt?.toISOString(),
    lastUsedAt: credential.lastUsedAt?.toISOString(),
    revokedAt: credential.revokedAt?.toISOString(),
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString(),
  };
}

const ISSUED_KEY_WARNING = "This is the only time the full API key will be shown. Store it securely now.";

/**
 * Registered under /api/v1/credentials. Every route requires authentication
 * — there is no public credential-creation endpoint (see the bootstrap CLI,
 * src/cli/bootstrap-tenant.ts, for how a tenant gets its first credential).
 */
export function credentialsRoutes(credentialService: ApiCredentialService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.post("/", { preHandler: fastify.authenticate }, async (request, reply) => {
      const tenantId = requireTenantId(request);
      const parsed = createCredentialBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid credential creation payload", {
          fieldErrors: z.flattenError(parsed.error).fieldErrors,
        });
      }

      const issued = await credentialService.issueCredential(
        tenantId,
        {
          name: parsed.data.name,
          ...(parsed.data.expiresAt ? { expiresAt: new Date(parsed.data.expiresAt) } : {}),
        },
        auditContextFrom(request),
      );

      reply.status(201);
      return { ...toSafeCredentialResponse(issued.credential), apiKey: issued.apiKey, warning: ISSUED_KEY_WARNING };
    });

    fastify.get("/", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const credentials = await credentialService.listCredentials(tenantId);
      return { credentials: credentials.map(toSafeCredentialResponse) };
    });

    fastify.post<{ Params: { id: string } }>(
      "/:id/rotate",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const credentialId = parseCredentialId(request.params.id);
        const issued = await credentialService.rotateCredential(tenantId, credentialId, auditContextFrom(request));
        return { ...toSafeCredentialResponse(issued.credential), apiKey: issued.apiKey, warning: ISSUED_KEY_WARNING };
      },
    );

    fastify.post<{ Params: { id: string } }>(
      "/:id/revoke",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const credentialId = parseCredentialId(request.params.id);
        const revoked = await credentialService.revokeCredential(tenantId, credentialId, auditContextFrom(request));
        return toSafeCredentialResponse(revoked);
      },
    );
  };
}
