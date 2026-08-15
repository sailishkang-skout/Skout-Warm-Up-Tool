import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./shared/config/index.js";
import { createDatabase, createPool, type Database } from "./shared/db/index.js";
import { DatabaseError } from "./shared/errors/index.js";
import { createLogger, type Logger } from "./shared/logger/index.js";

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    // The full typed logger needs a validated config to build, so a config
    // failure is reported through a minimal bootstrap logger instead — it
    // must never echo raw process.env values, only the sanitized error
    // message `loadConfig` already produced.
    const bootstrapLogger = createLogger({
      level: "info",
      serviceName: process.env.SERVICE_NAME ?? "skout-email-warmup-service",
      env: process.env.NODE_ENV ?? "development",
    });
    bootstrapLogger.error({ err: error }, "Invalid configuration - refusing to start");
    process.exit(1);
  }
}

async function connectDatabaseOrExit(config: AppConfig, logger: Logger): Promise<Database> {
  const pool = createPool(config.database, logger);
  const database = createDatabase(pool, logger);

  const isConnected = await database.checkConnectivity();
  if (!isConnected) {
    logger.error(
      { err: new DatabaseError("Failed to establish initial database connectivity") },
      "Database initialization failed - refusing to start",
    );
    await database.close().catch(() => undefined);
    process.exit(1);
  }

  return database;
}

// Startup order matters: config → logger → database → application → server.
// Database connectivity is verified before the app is even built, so a
// broken database never results in a partially-working process that accepts
// traffic it can't actually serve.
const config = loadConfigOrExit();
const logger = createLogger({
  level: config.log.level,
  serviceName: config.service.name,
  env: config.env,
});
const database = await connectDatabaseOrExit(config, logger);
const app = await buildApp(config, logger, database);

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  logger.info({ signal }, "Received shutdown signal, closing gracefully");
  try {
    // app.close() stops accepting new connections and waits for in-flight
    // requests before resolving, so the database is only closed once
    // nothing can issue a query against it anymore.
    await app.close();
    await database.close();
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, "Error during shutdown");
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

try {
  await app.listen({
    port: config.http.port,
    host: "0.0.0.0",
  });
} catch (error) {
  app.log.error(error);
  await database.close().catch(() => undefined);
  process.exit(1);
}
