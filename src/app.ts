import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  await app.register(helmet);

  await app.register(cors, {
    origin: false,
  });

  app.get("/health", async () => {
    return {
      status: "ok",
      service: "skout-email-warmup-service",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    };
  });

  return app;
}
