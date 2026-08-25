import { Pool } from "pg";
import type { AppConfig } from "../config/index.js";
import type { Logger } from "../logger/index.js";

/**
 * RDS terminates TLS with Amazon's CA; Node's default trust store rejects it
 * unless we set `rejectUnauthorized: false` (same approach as Skout API).
 * Local Docker Postgres has no TLS — skip ssl entirely for localhost URLs.
 */
function resolveSsl(connectionString: string): false | { rejectUnauthorized: false } {
  try {
    const url = new URL(connectionString);
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1") return false;
    const sslmode = url.searchParams.get("sslmode");
    if (sslmode === "disable") return false;
  } catch {
    /* fall through */
  }
  if (process.env.DATABASE_SSL === "false") return false;
  return { rejectUnauthorized: false };
}

/**
 * A `pg.Pool` emits an `error` event for problems on an already-checked-in
 * idle client (e.g. the server terminated its connection) — outside the
 * context of any in-flight query. Without a listener here, that becomes an
 * unhandled 'error' event and crashes the process; this is the single most
 * common node-postgres foot-gun, so it's wired up unconditionally.
 */
export function createPool(database: AppConfig["database"], logger: Logger): Pool {
  const statementTimeoutMs = Math.max(0, Math.floor(database.statementTimeoutMs));
  const ssl = resolveSsl(database.url);
  const pool = new Pool({
    connectionString: database.url,
    min: database.poolMin,
    max: database.poolMax,
    connectionTimeoutMillis: database.connectionTimeoutMs,
    idleTimeoutMillis: database.idleTimeoutMs,
    ...(ssl ? { ssl } : {}),
    ...(statementTimeoutMs > 0 ? { options: `-c statement_timeout=${statementTimeoutMs}` } : {}),
  });

  pool.on("error", (error) => {
    logger.error({ err: error }, "Unexpected error on an idle database client");
  });

  return pool;
}
