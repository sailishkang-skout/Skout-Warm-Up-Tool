import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { AuthorizationError } from "../../../shared/errors/index.js";
import type { TenantId } from "../../../shared/types/index.js";
import type { ProviderRegistry } from "../application/provider-registry.js";
import type { ManagedDirectoryProvider } from "../../managed-directory/domain/managed-directory-provider.js";

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

export function providerCatalogRoutes(
  registry: ProviderRegistry,
  directories: Readonly<Record<"GMAIL" | "MICROSOFT365", ManagedDirectoryProvider>>,
): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.addHook("preHandler", fastify.authenticate);

    fastify.get("/", async (request) => {
      requireTenantId(request);
      const types = ["GMAIL", "MICROSOFT365", "SMTP_IMAP"] as const;
      return {
        providers: types.map((type) => {
          const adapter = registry.resolve(type);
          const directory = type === "SMTP_IMAP" ? undefined : directories[type];
          return {
            type,
            configurationStatus: adapter.getConfigurationStatus(),
            capabilities: adapter.getCapabilities(),
            directoryConfigurationStatus: directory?.getConfigurationStatus() ?? "NOT_CONFIGURED",
          };
        }),
      };
    });
  };
}
