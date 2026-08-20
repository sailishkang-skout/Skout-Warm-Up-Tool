import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { buildServices } from "../composition/build-services.js";
import { loadConfig, type AppConfig } from "../shared/config/index.js";
import { createDatabase, createPool, type Database } from "../shared/db/index.js";
import { DatabaseError, TransientError } from "../shared/errors/index.js";
import { createLogger, type Logger } from "../shared/logger/index.js";
import { incrementCounter, METRIC } from "../shared/observability/index.js";
import { checkRedisConnectivity, createRedisClient, type RedisClient } from "../shared/redis/index.js";

/**
 * Stage 13B classification worker — independent of inbound polling and
 * warmup execution. Never sends mail or mutates warmup policy.
 */

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    const bootstrapLogger = createLogger({
      level: "info",
      serviceName: process.env.SERVICE_NAME ?? "skout-email-warmup-service-classification",
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
    logger.error({ err: new DatabaseError("Failed to establish initial database connectivity") }, "Database initialization failed - refusing to start");
    await database.close().catch(() => undefined);
    process.exit(1);
  }
  return database;
}

async function connectRedisOrExit(config: AppConfig, logger: Logger): Promise<RedisClient> {
  const redis = createRedisClient(config.redis.url, logger);
  const isConnected = await checkRedisConnectivity(redis);
  if (!isConnected) {
    logger.error({ err: new TransientError("Failed to establish initial Redis connectivity") }, "Redis initialization failed - refusing to start");
    redis.disconnect();
    process.exit(1);
  }
  return redis;
}

function interruptibleSleep(ms: number, onInterruptible: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    onInterruptible(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger({
    level: config.log.level,
    serviceName: `${config.service.name}-classification`,
    env: config.env,
  });
  const database = await connectDatabaseOrExit(config, logger);
  const redis = await connectRedisOrExit(config, logger);
  const services = buildServices(config, logger, database, redis);

  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  logger.info(
    { workerId, pollIntervalMs: config.workers.classificationPollIntervalMs, aiProvider: config.ai.provider },
    "Conversation classification worker starting",
  );

  let shuttingDown = false;
  let wake: (() => void) | undefined;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      return;
    }
    logger.info({ signal, workerId }, "Received shutdown signal - finishing the current tick, then stopping");
    shuttingDown = true;
    wake?.();
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  while (!shuttingDown) {
    try {
      const result = await services.classificationWorker.runTick(workerId);
      incrementCounter(METRIC.classificationTick);
      if (result.reclaimedLeases > 0) {
        incrementCounter(METRIC.leaseReclaimed, result.reclaimedLeases);
      }
      if (result.processed > 0 || result.reclaimedLeases > 0) {
        logger.info({ workerId, ...result }, "Classification tick completed");
      } else {
        logger.debug({ workerId, ...result }, "Classification tick completed - nothing due");
      }
    } catch (err) {
      incrementCounter(METRIC.classificationTickFailure);
      logger.error({ err, workerId }, "Classification tick failed");
    }

    if (shuttingDown) {
      break;
    }
    await interruptibleSleep(config.workers.classificationPollIntervalMs, (wakeNow) => {
      wake = wakeNow;
    });
  }

  logger.info({ workerId }, "Conversation classification worker shutting down");
  await database.close().catch((err: unknown) => logger.error({ err }, "Error closing database connection"));
  redis.disconnect();
  process.exit(0);
}

await main();
