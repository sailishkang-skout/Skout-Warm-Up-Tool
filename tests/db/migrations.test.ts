/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`, which
 * expects `docker compose up -d postgres` (or an equivalent Postgres
 * reachable at TEST_DATABASE_URL) to already be running. This suite
 * deliberately never mocks SQL/migration behavior — it runs the real
 * migration runner against a real, disposable test database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getMigrationStatus, runMigrations } from "../../src/shared/db/index.js";
import { DatabaseError } from "../../src/shared/errors/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { createTestDatabaseHandle, ensureTestDatabaseExists, resetSchema, type TestDatabaseHandle } from "./support.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });

const ALL_MIGRATION_FILENAMES = [
  "001_create_tenants.sql",
  "002_create_mailboxes.sql",
  "003_create_provider_accounts.sql",
  "004_create_api_credentials.sql",
  "005_create_audit_events.sql",
  "006_mailbox_lifecycle_and_provider_metadata.sql",
];

let handle: TestDatabaseHandle;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
}, 30_000);

beforeEach(async () => {
  await resetSchema(handle.pool);
});

afterAll(async () => {
  // Guards against beforeAll having failed before `handle` was assigned —
  // otherwise a database-unavailable failure gets masked by a confusing
  // "Cannot read properties of undefined" from this hook instead.
  if (handle) {
    await handle.database.close();
  }
});

describe("runMigrations", () => {
  it("applies all migrations from an empty schema and creates the expected tables", async () => {
    const result = await runMigrations(handle.pool, logger);

    expect(result.applied).toEqual(ALL_MIGRATION_FILENAMES);
    expect(result.alreadyApplied).toEqual([]);

    // No error on SELECT from each table means it exists with the expected name.
    await expect(handle.database.query("SELECT * FROM tenants LIMIT 0")).resolves.toEqual([]);
    await expect(handle.database.query("SELECT * FROM mailboxes LIMIT 0")).resolves.toEqual([]);
    await expect(handle.database.query("SELECT * FROM provider_accounts LIMIT 0")).resolves.toEqual([]);
    await expect(handle.database.query("SELECT * FROM api_credentials LIMIT 0")).resolves.toEqual([]);
    await expect(handle.database.query("SELECT * FROM audit_events LIMIT 0")).resolves.toEqual([]);
  });

  it("is idempotent — running it again applies nothing further", async () => {
    await runMigrations(handle.pool, logger);
    const second = await runMigrations(handle.pool, logger);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(ALL_MIGRATION_FILENAMES);
  });

  it("detects a checksum change on an already-applied migration and refuses to proceed", async () => {
    await runMigrations(handle.pool, logger);

    await handle.pool.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");

    await expect(runMigrations(handle.pool, logger)).rejects.toThrow(DatabaseError);
    await expect(runMigrations(handle.pool, logger)).rejects.toThrow(/checksum mismatch/);
  });
});

describe("getMigrationStatus", () => {
  it("reports every migration as pending against an empty schema", async () => {
    const status = await getMigrationStatus(handle.pool);
    expect(status.every((entry) => !entry.applied)).toBe(true);
    expect(status.map((entry) => entry.version)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reports applied migrations with an appliedAt timestamp after running them", async () => {
    await runMigrations(handle.pool, logger);
    const status = await getMigrationStatus(handle.pool);

    expect(status.every((entry) => entry.applied)).toBe(true);
    for (const entry of status) {
      expect(entry.appliedAt).toBeInstanceOf(Date);
    }
  });
});
