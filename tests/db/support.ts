import { Client, DatabaseError as PgDatabaseError, Pool } from "pg";
import { createDatabase, createPool, type Database } from "../../src/shared/db/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { createRedisClient, type RedisClient } from "../../src/shared/redis/index.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/skout_warmup_test";

// Logical database 1, not 0: this suite must never share keyspace with a
// developer's own `redis-cli` session against the same docker-compose Redis
// instance (there is no separate "test Redis" the way TEST_DATABASE_URL
// gets a wholly separate Postgres database) — an isolated logical DB is the
// cheapest equivalent, and lets `flushTestRedis` use FLUSHDB safely.
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380/1";

export function createTestRedisHandle(): RedisClient {
  const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
  return createRedisClient(TEST_REDIS_URL, logger);
}

export async function flushTestRedis(redis: RedisClient): Promise<void> {
  await redis.flushdb();
}

// 42P04 (duplicate_database) is what a straightforward "already exists"
// check produces. 23505 (unique_violation) is what a genuine *concurrent*
// `CREATE DATABASE` race produces instead (it fails at the `pg_database`
// catalog's unique index rather than the friendlier existence check) —
// exercised for real whenever multiple test files run in parallel and each
// calls this function in its own `beforeAll`. Both mean the same thing here:
// the database exists (or is about to), which is all this function promises.
const IGNORABLE_ERROR_CODES = new Set(["42P04", "23505"]);
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function databaseNameFrom(connectionString: string): string {
  return new URL(connectionString).pathname.replace(/^\//, "");
}

function withDatabaseName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * `CREATE DATABASE <name>` can't use a parameterized identifier — Postgres
 * has no bind-parameter syntax for DDL identifiers. Safe here only because
 * `databaseName` always comes from this repo's own TEST_DATABASE_URL config,
 * never from a request or any external input; it's still validated against
 * a strict identifier pattern before interpolation as defense in depth.
 */
function assertSafeIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Refusing to use '${name}' as a SQL identifier - it doesn't match ${SAFE_IDENTIFIER}`);
  }
}

/**
 * Creates the test database on demand by connecting to the `postgres`
 * maintenance database, rather than relying on a docker-entrypoint-initdb.d
 * script — that only runs once against a brand-new empty volume, so it
 * silently no-ops for anyone with a pre-existing postgres data volume from
 * before this database existed. This works regardless of volume history.
 */
export async function ensureTestDatabaseExists(): Promise<void> {
  const databaseName = databaseNameFrom(TEST_DATABASE_URL);
  assertSafeIdentifier(databaseName);

  const client = new Client({ connectionString: withDatabaseName(TEST_DATABASE_URL, "postgres") });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${databaseName}`);
  } catch (error) {
    if (!(error instanceof PgDatabaseError && error.code && IGNORABLE_ERROR_CODES.has(error.code))) {
      throw error;
    }
  } finally {
    await client.end();
  }
}

export interface TestDatabaseHandle {
  readonly pool: Pool;
  readonly database: Database;
}

export function createTestDatabaseHandle(): TestDatabaseHandle {
  const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
  const pool = createPool(
    {
      url: TEST_DATABASE_URL,
      poolMin: 1,
      poolMax: 10,
      connectionTimeoutMs: 5000,
      idleTimeoutMs: 30000,
      statementTimeoutMs: 30000,
    },
    logger,
  );
  return { pool, database: createDatabase(pool, logger) };
}

/** Drops every object migrations create, for tests that exercise the migration runner itself from empty state. */
export async function resetSchema(pool: Pool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS warmup_pool_memberships CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_pools CASCADE");
  await pool.query("DROP FUNCTION IF EXISTS enforce_warmup_pool_tenant_isolation() CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_network_routing_decisions CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_network_mailboxes CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_network_domains CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_network_pools CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_networks CASCADE");
  await pool.query("DROP TABLE IF EXISTS integration_events_outbox CASCADE");
  await pool.query("DROP FUNCTION IF EXISTS reject_integration_events_outbox_mutation() CASCADE");
  await pool.query("DROP TABLE IF EXISTS conversation_policy_signals CASCADE");
  await pool.query("DROP TABLE IF EXISTS conversation_policy_evaluations CASCADE");
  await pool.query("DROP TABLE IF EXISTS conversation_domain_facts CASCADE");
  await pool.query("DROP TABLE IF EXISTS conversation_classification_facts CASCADE");
  await pool.query("DROP TABLE IF EXISTS conversation_message_classifications CASCADE");
  await pool.query("DROP TABLE IF EXISTS conversation_messages CASCADE");
  await pool.query("DROP TABLE IF EXISTS conversations CASCADE");
  await pool.query("DROP TABLE IF EXISTS mailbox_inbound_sync_state CASCADE");
  await pool.query("DROP TABLE IF EXISTS reputation_assessments CASCADE");
  await pool.query("DROP TABLE IF EXISTS delivery_events CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_execution_intents CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_decisions CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_sessions CASCADE");
  await pool.query("DROP TABLE IF EXISTS warmup_profiles CASCADE");
  await pool.query("DROP TABLE IF EXISTS mailbox_assessments CASCADE");
  await pool.query("DROP TABLE IF EXISTS mailbox_signals CASCADE");
  await pool.query("DROP TABLE IF EXISTS domain_intelligence CASCADE");
  await pool.query("DROP TABLE IF EXISTS connection_attempts CASCADE");
  await pool.query("DROP TABLE IF EXISTS provider_credentials CASCADE");
  await pool.query("DROP TABLE IF EXISTS audit_events CASCADE");
  await pool.query("DROP TABLE IF EXISTS api_credentials CASCADE");
  await pool.query("DROP TABLE IF EXISTS provider_accounts CASCADE");
  await pool.query("DROP TABLE IF EXISTS mailboxes CASCADE");
  await pool.query("DROP TABLE IF EXISTS tenants CASCADE");
  await pool.query("DROP TABLE IF EXISTS schema_migrations CASCADE");
  await pool.query("DROP FUNCTION IF EXISTS set_updated_at CASCADE");
}

/** For tests that need the schema in place but a clean set of rows between cases. */
export async function truncateAppTables(pool: Pool): Promise<void> {
  await pool.query(
    "TRUNCATE TABLE warmup_pool_memberships, warmup_pools, warmup_network_routing_decisions, warmup_network_mailboxes, warmup_network_domains, warmup_network_pools, warmup_networks, integration_events_outbox, conversation_policy_signals, conversation_policy_evaluations, conversation_domain_facts, conversation_classification_facts, conversation_message_classifications, conversation_messages, conversations, mailbox_inbound_sync_state, reputation_assessments, delivery_events, warmup_execution_intents, warmup_decisions, warmup_sessions, warmup_profiles, mailbox_assessments, mailbox_signals, domain_intelligence, connection_attempts, provider_credentials, audit_events, api_credentials, provider_accounts, mailboxes, tenants RESTART IDENTITY",
  );
}
