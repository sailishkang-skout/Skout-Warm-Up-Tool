import type { Database, PoolStats } from "../../src/shared/db/index.js";

export interface FakeDatabaseOptions {
  readonly connected?: boolean;
}

/**
 * A `Database` double for tests that exercise HTTP routing/wiring (e.g. the
 * /readiness branch logic) without needing a real Postgres connection. Real
 * SQL behavior (queries, transactions, constraints) is deliberately never
 * faked — see tests/db/ for that, which runs against actual Postgres.
 */
export function createFakeDatabase(options: FakeDatabaseOptions = {}): Database {
  const connected = options.connected ?? true;

  return {
    query() {
      return Promise.reject(new Error("createFakeDatabase: query() is not supported by this test double"));
    },
    withTransaction() {
      return Promise.reject(
        new Error("createFakeDatabase: withTransaction() is not supported by this test double"),
      );
    },
    checkConnectivity(): Promise<boolean> {
      return Promise.resolve(connected);
    },
    getPoolStats(): PoolStats {
      return { total: 0, idle: 0, waiting: 0 };
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}
