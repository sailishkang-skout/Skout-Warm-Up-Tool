import type { Pool, PoolClient, QueryResultRow } from "pg";
import { AppError } from "../errors/index.js";
import type { Logger } from "../logger/index.js";
import { mapDatabaseError } from "./errors.js";

/**
 * What repository code actually depends on — never the raw `pg` `Pool`/
 * `PoolClient` types. This is the whole point of the boundary: business
 * logic knows how to run parameterized queries, not how connections are
 * pooled or transactions are demarcated.
 */
export interface DatabaseClient {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

function wrapClient(client: PoolClient): DatabaseClient {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<T[]> {
      try {
        const result = await client.query<T>(text, params as unknown[] | undefined);
        return result.rows;
      } catch (error) {
        throw mapDatabaseError(error);
      }
    },
  };
}

async function runControlStatement(client: PoolClient, sql: "BEGIN" | "COMMIT"): Promise<void> {
  try {
    await client.query(sql);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Acquires a dedicated connection, runs `fn` against it inside
 * BEGIN/COMMIT/ROLLBACK, and always releases the connection back to the
 * pool — whether `fn` throws, or `COMMIT` itself fails.
 *
 * `fn` only ever sees a `DatabaseClient`, which has no `withTransaction` of
 * its own — nesting a transaction inside a transaction is therefore a
 * compile error, not a runtime surprise. Postgres doesn't have real nested
 * transactions (SAVEPOINTs are a different feature this service doesn't
 * need yet), so accidental nesting is prevented by the type system rather
 * than a runtime guard.
 */
export async function runInTransaction<T>(
  pool: Pool,
  logger: Logger,
  fn: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    const mapped = mapDatabaseError(error);
    logger.error({ err: mapped }, "Failed to acquire a database connection");
    throw mapped;
  }

  try {
    await runControlStatement(client, "BEGIN");
    const result = await fn(wrapClient(client));
    await runControlStatement(client, "COMMIT");
    return result;
  } catch (error) {
    // Everything reaching this catch is already well-formed: BEGIN/COMMIT
    // failures and any query failure inside `fn` (via wrapClient above) are
    // mapped to AppError at the point they're thrown. Anything else is a
    // non-database error `fn` threw deliberately (a business-rule check
    // failing, for instance) — it must keep its own identity here, not get
    // relabeled as "a database error" just because it happened inside one.
    if (error instanceof AppError && error.httpStatus < 500) {
      logger.warn({ err: error }, "Transaction failed, rolling back");
    } else {
      logger.error({ err: error }, "Transaction failed, rolling back");
    }

    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, "Failed to roll back transaction after an error");
    }

    throw error;
  } finally {
    client.release();
  }
}
