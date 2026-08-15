import { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";

/**
 * A `pg.Pool` emits an `error` event for problems on an already-checked-in
 * idle client (e.g. the server terminated its connection) — outside the
 * context of any in-flight query. Without a listener here, that becomes an
 * unhandled 'error' event and crashes the process; this is the single most
 * common node-postgres foot-gun, so it's wired up unconditionally.
 */
export function createPool(database: AppConfig["database"], logger: Logger): Pool {
  const pool = new Pool({
    connectionString: database.url,
    min: database.poolMin,
    max: database.poolMax,
    connectionTimeoutMillis: database.connectionTimeoutMs,
    idleTimeoutMillis: database.idleTimeoutMs,
  });

  pool.on("error", (error) => {
    logger.error({ err: error }, "Unexpected error on an idle database client");
  });

  return pool;
}
