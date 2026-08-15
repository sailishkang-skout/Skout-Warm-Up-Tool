import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { requestContextPlugin } from "./plugins/request-context.js";
import type { AppConfig } from "./shared/config/index.js";
import { createLogger } from "./shared/logger/index.js";

// Return type intentionally inferred, not annotated: `loggerInstance` below is
// a concrete pino `Logger`, which parameterizes Fastify's instance type more
// precisely than the library's own `FastifyInstance` default-generic alias
// (`FastifyBaseLogger`) can express — annotating with that default would
// reject the very instance `Fastify()` returns.
export async function buildApp(config: AppConfig) {
  const app = Fastify({
    loggerInstance: createLogger({
      level: config.log.level,
      serviceName: config.service.name,
      env: config.env,
    }),
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(helmet);
  await app.register(cors, {
    origin: false,
  });

  app.get("/health", async () => {
    return {
      status: "ok",
      service: config.service.name,
      version: config.service.version,
      timestamp: new Date().toISOString(),
    };
  });

  return app;
}
