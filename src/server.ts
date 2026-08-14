import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import "dotenv/config";

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

const port = Number(process.env.PORT ?? 3010);

try {
  await app.listen({
    port,
    host: "0.0.0.0",
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
