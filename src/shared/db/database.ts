import type { Pool, QueryResultRow } from "pg";
import type { Logger } from "../logger/index.js";
import { mapDatabaseError } from "./errors.js";
import { runInTransaction, type DatabaseClient } from "./transaction.js";

export interface PoolStats {
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
}

/**
 * The one thing repository/application code is allowed to depend on for
 * persistence — never a raw `pg.Pool`. `query` covers single statements
 * outside a transaction; `withTransaction` covers everything that needs
 * atomicity across multiple statements.
 */
export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<T[]>;
  withTransaction<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T>;
  checkConnectivity(): Promise<boolean>;
  getPoolStats(): PoolStats;
  close(): Promise<void>;
}

export function createDatabase(pool: Pool, logger: Logger): Database {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      try {
        const result = await pool.query<T>(text, params as unknown[] | undefined);
        return result.rows;
      } catch (error) {
        const mapped = mapDatabaseError(error);
        const logPayload = { err: mapped };
        if (mapped.httpStatus >= 500) {
          logger.error(logPayload, "Database query failed");
        } else {
          logger.warn(logPayload, "Database query failed");
        }
        throw mapped;
      }
    },

    withTransaction<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
      return runInTransaction(pool, logger, fn);
    },

    async checkConnectivity(): Promise<boolean> {
      try {
        await pool.query("SELECT 1");
        return true;
      } catch (error) {
        logger.error({ err: mapDatabaseError(error) }, "Database connectivity check failed");
        return false;
      }
    },

    getPoolStats(): PoolStats {
      return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
