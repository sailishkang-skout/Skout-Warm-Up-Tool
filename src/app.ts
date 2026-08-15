import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { requestContextPlugin } from "./plugins/request-context.js";
import type { AppConfig } from "./shared/config/index.js";
import type { Database } from "./shared/db/index.js";
import type { Logger } from "./shared/logger/index.js";

// Return type intentionally inferred, not annotated: `loggerInstance` below is
// a concrete pino `Logger`, which parameterizes Fastify's instance type more
// precisely than the library's own `FastifyInstance` default-generic alias
// (`FastifyBaseLogger`) can express — annotating with that default would
// reject the very instance `Fastify()` returns.
export async function buildApp(config: AppConfig, logger: Logger, database: Database) {
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

  // "process is alive" — deliberately has no dependency on the database or
  // any other downstream system. A liveness probe that can fail because a
  // dependency is unavailable defeats its own purpose (an orchestrator would
  // restart a perfectly healthy process for a problem restarting it can't fix).
  app.get("/health", async () => {
    return {
      status: "ok",
      service: config.service.name,
      version: config.service.version,
      timestamp: new Date().toISOString(),
    };
  });

  // "process is capable of serving requests" — checks the dependencies that
  // actually determine that. Only Postgres exists as a dependency so far;
  // Redis/worker/provider checks join this as those stages land.
  app.get("/readiness", async (_request, reply) => {
    const databaseOk = await database.checkConnectivity();
    const checks = { database: databaseOk ? "ok" : "unavailable" } as const;

    if (!databaseOk) {
      reply.status(503);
      return { status: "not_ready", checks };
    }
    return { status: "ready", checks };
  });

  return app;
}
