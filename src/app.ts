import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { credentialsRoutes } from "./modules/auth/api/credentials-routes.js";
import { mailboxAssessmentRoutes } from "./modules/health/api/mailbox-assessment-routes.js";
import { mailboxRoutes } from "./modules/mailbox/api/mailbox-routes.js";
import { oauthRoutes } from "./modules/oauth/api/oauth-routes.js";
import { buildServices } from "./composition/build-services.js";
import { authenticationPlugin } from "./plugins/authentication.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { requestContextPlugin } from "./plugins/request-context.js";
import type { AppConfig } from "./shared/config/index.js";
import type { Database } from "./shared/db/index.js";
import type { Logger } from "./shared/logger/index.js";
import { checkRedisConnectivity, type RedisClient } from "./shared/redis/index.js";

// Return type intentionally inferred, not annotated: `loggerInstance` below is
// a concrete pino `Logger`, which parameterizes Fastify's instance type more
// precisely than the library's own `FastifyInstance` default-generic alias
// (`FastifyBaseLogger`) can express — annotating with that default would
// reject the very instance `Fastify()` returns.
export async function buildApp(config: AppConfig, logger: Logger, database: Database, redis: RedisClient) {
  const app = Fastify({
    loggerInstance: logger,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(helmet);
  await app.register(cors, {
    origin: false,
  });

  // Composition root builds every repository/service; app.ts only wires
  // plugins/routes against the result (see src/composition/build-services.ts).
  const services = buildServices(config, logger, database, redis);

  await app.register(authenticationPlugin(services.authenticationService));
  await app.register(credentialsRoutes(services.credentialService), { prefix: "/api/v1/credentials" });
  await app.register(mailboxRoutes(services.mailboxService, services.oauthConnectionService), {
    prefix: "/api/v1/mailboxes",
  });
  // Public — no fastify.authenticate — because a provider's redirect back
  // to this service never carries a Skout API key. See
  // src/modules/oauth/api/oauth-routes.ts for how the callback is secured
  // instead (single-use, tenant/mailbox/provider-bound OAuth state).
  await app.register(oauthRoutes(services.oauthConnectionService), { prefix: "/api/v1/oauth" });
  await app.register(mailboxAssessmentRoutes(services.mailboxAssessmentService), { prefix: "/api/v1/mailboxes" });

  // "process is alive" — deliberately has no dependency on the database or
  // any other downstream system. A liveness probe that can fail because a
  // dependency is unavailable defeats its own purpose (an orchestrator would
  // restart a perfectly healthy process for a problem restarting it can't fix).
  // Public: no authentication required.
  app.get("/health", async () => {
    return {
      status: "ok",
      service: config.service.name,
      version: config.service.version,
      timestamp: new Date().toISOString(),
    };
  });

  // "process is capable of serving requests" — checks the dependencies that
  // actually determine that. Redis joined this in Stage 6 (OAuth state and
  // the per-mailbox connection lock both depend on it); worker/queue checks
  // join as those stages land.
  // Public: no authentication required — an orchestrator's health checker
  // has no credential, and this endpoint reveals nothing tenant-specific.
  app.get("/readiness", async (_request, reply) => {
    const [databaseOk, redisOk] = await Promise.all([database.checkConnectivity(), checkRedisConnectivity(redis)]);
    const checks = {
      database: databaseOk ? "ok" : "unavailable",
      redis: redisOk ? "ok" : "unavailable",
    } as const;

    if (!databaseOk || !redisOk) {
      reply.status(503);
      return { status: "not_ready", checks };
    }
    return { status: "ready", checks };
  });

  return app;
}
