import "dotenv/config";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { buildServices } from "../composition/build-services.js";
import { loadConfig, type AppConfig } from "../shared/config/index.js";
import { createDatabase, createPool, type Database } from "../shared/db/index.js";
import { DatabaseError, TransientError } from "../shared/errors/index.js";
import { createLogger, type Logger } from "../shared/logger/index.js";
import { incrementCounter, METRIC } from "../shared/observability/index.js";
import { createRedisClient, waitForRedisConnectivity, type RedisClient } from "../shared/redis/index.js";

/**
 * The long-running worker process Stage 12 spec's "WORKER CADENCE" asks
 * for — a standalone entrypoint (separate from the HTTP API process, same
 * as `src/server.ts`), independently deployable/restartable/scalable. Its
 * only job is calling `WarmupScheduler.runTick` on a fixed interval; every
 * decision about whether an action is safe still happens entirely inside
 * that call's existing, unmodified `WarmupService`/`ExecutionWorker` chain
 * — this file contains no domain logic of its own.
 */

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    const bootstrapLogger = createLogger({
      level: "info",
      serviceName: process.env.SERVICE_NAME ?? "skout-email-warmup-service-worker",
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
  const isConnected = await waitForRedisConnectivity(redis);
  if (!isConnected) {
    logger.error({ err: new TransientError("Failed to establish initial Redis connectivity") }, "Redis initialization failed - refusing to start");
    redis.disconnect();
    process.exit(1);
  }
  return redis;
}

/**
 * A `setTimeout`-based sleep, not `setInterval` (Stage 12 spec: "Prefer a
 * sleep-based async loop rather than setInterval if that prevents
 * overlapping iterations" — the outer loop below is a strict
 * await-sequential chain, so a tick can never start before the previous one
 * finished, however long it ran). Interruptible so a shutdown signal wakes
 * the process immediately rather than waiting out the configured poll interval.
 */
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
  const logger = createLogger({ level: config.log.level, serviceName: `${config.service.name}-worker`, env: config.env });
  const database = await connectDatabaseOrExit(config, logger);
  const redis = await connectRedisOrExit(config, logger);
  const services = buildServices(config, logger, database, redis);

  const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  logger.info({ workerId, pollIntervalMs: config.workers.warmupPollIntervalMs }, "Execution worker process starting");

  let shuttingDown = false;
  let wake: (() => void) | undefined;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      return;
    }
    // Only stops scheduling a *new* tick — a tick already in progress runs
    // to completion (every claimed intent reaches a terminal or re-queued
    // state before `runTick` returns; there is nothing to force-release
    // here). A process killed before that finishes (SIGKILL, or a crash)
    // relies on the same lease-expiry + reclaim path every other worker
    // crash does — no shutdown-specific lease handling is needed beyond
    // "stop starting new work."
    logger.info({ signal, workerId }, "Received shutdown signal - finishing the current tick, then stopping");
    shuttingDown = true;
    wake?.();
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  while (!shuttingDown) {
    try {
      const result = await services.warmupScheduler.runTick(workerId);
      incrementCounter(METRIC.warmupTick);
      if (result.reclaimedLeases > 0) {
        incrementCounter(METRIC.leaseReclaimed, result.reclaimedLeases);
      }
      if (result.reclaimedLeases > 0 || result.sessionsAdvanced > 0 || result.intentsProcessed > 0) {
        logger.info({ workerId, ...result }, "Scheduler tick completed");
      } else {
        logger.debug({ workerId, ...result }, "Scheduler tick completed - nothing due");
      }
    } catch (err) {
      // A tick failure (e.g. a transient Postgres/Redis blip) is logged and
      // the loop continues on the next poll — it must never turn into a
      // provider send, and it never does: this catch is around
      // `runTick` itself, not around any provider call, which
      // `ExecutionWorker.processNext` already isolates per-intent.
      incrementCounter(METRIC.warmupTickFailure);
      logger.error({ err, workerId }, "Scheduler tick failed");
    }

    if (shuttingDown) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await interruptibleSleep(config.workers.warmupPollIntervalMs, (wakeNow) => {
      wake = wakeNow;
    });
  }

  logger.info({ workerId }, "Execution worker process shutting down");
  await database.close().catch((err: unknown) => logger.error({ err }, "Error closing database connection"));
  redis.disconnect();
  process.exit(0);
}

await main();
