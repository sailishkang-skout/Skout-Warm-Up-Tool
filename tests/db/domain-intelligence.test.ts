/**
 * Requires a live PostgreSQL and Redis instance. Run via `npm run test:db`.
 * Exercises the real Postgres-backed repository and Redis-backed cache —
 * no mocked SQL or Redis behavior. DNS itself is never touched here (see
 * tests/unit/node-dns-resolver.test.ts for that).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresDomainIntelligenceRepository } from "../../src/modules/domain-intelligence/infrastructure/postgres-domain-intelligence-repository.js";
import { createRedisDomainCache } from "../../src/modules/domain-intelligence/infrastructure/redis-domain-cache.js";
import type { DomainAuthenticationAssessment } from "../../src/modules/domain-intelligence/domain/domain-authentication.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import type { RedisClient } from "../../src/shared/redis/index.js";
import {
  createTestDatabaseHandle,
  createTestRedisHandle,
  ensureTestDatabaseExists,
  flushTestRedis,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });

let handle: TestDatabaseHandle;
let redis: RedisClient;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  redis = createTestRedisHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, logger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
  await flushTestRedis(redis);
});

afterAll(async () => {
  if (handle) await handle.database.close();
  if (redis) redis.disconnect();
});

function assessment(overrides: Partial<DomainAuthenticationAssessment> = {}): DomainAuthenticationAssessment {
  return {
    domain: "example.com",
    mx: { status: "PASS", records: ["mx1.example.com", "mx2.example.com"] },
    spf: { status: "PASS", record: "v=spf1 -all" },
    dkim: { status: "PASS", selector: "google" },
    dmarc: { status: "PASS", policy: "reject", record: "v=DMARC1; p=reject" },
    checkedAt: new Date(),
    ...overrides,
  };
}

describe("PostgresDomainIntelligenceRepository", () => {
  it("round-trips a full assessment", async () => {
    const repository = createPostgresDomainIntelligenceRepository(handle.database);
    await repository.upsert(assessment());

    const found = await repository.findByDomain("example.com");
    expect(found).toMatchObject({
      domain: "example.com",
      mx: { status: "PASS", records: ["mx1.example.com", "mx2.example.com"] },
      spf: { status: "PASS", record: "v=spf1 -all" },
      dkim: { status: "PASS", selector: "google" },
      dmarc: { status: "PASS", policy: "reject" },
    });
  });

  it("returns undefined for an unknown domain", async () => {
    const repository = createPostgresDomainIntelligenceRepository(handle.database);
    await expect(repository.findByDomain("never-checked.example")).resolves.toBeUndefined();
  });

  it("upsert replaces the row in place rather than creating a new one", async () => {
    const repository = createPostgresDomainIntelligenceRepository(handle.database);
    await repository.upsert(assessment({ mx: { status: "PASS", records: ["old.example.com"] } }));
    await repository.upsert(assessment({ mx: { status: "MISSING", records: [] } }));

    const rows = await handle.database.query("SELECT * FROM domain_intelligence WHERE domain = $1", ["example.com"]);
    expect(rows).toHaveLength(1);
    const found = await repository.findByDomain("example.com");
    expect(found?.mx.status).toBe("MISSING");
  });

  it("persists an absent DMARC policy as absent, not a guessed default", async () => {
    const repository = createPostgresDomainIntelligenceRepository(handle.database);
    await repository.upsert(assessment({ dmarc: { status: "MISSING" } }));

    const found = await repository.findByDomain("example.com");
    expect(found?.dmarc.policy).toBeUndefined();
  });

  it("keeps different domains fully independent", async () => {
    const repository = createPostgresDomainIntelligenceRepository(handle.database);
    await repository.upsert(assessment({ domain: "example.com" }));
    await repository.upsert(assessment({ domain: "other.example", mx: { status: "MISSING", records: [] } }));

    expect((await repository.findByDomain("example.com"))?.mx.status).toBe("PASS");
    expect((await repository.findByDomain("other.example"))?.mx.status).toBe("MISSING");
  });
});

describe("RedisDomainCache", () => {
  it("round-trips an assessment including its Date field", async () => {
    const cache = createRedisDomainCache(redis);
    const value = assessment();
    await cache.set("example.com", value, 3600);

    const found = await cache.get("example.com");
    expect(found?.domain).toBe("example.com");
    expect(found?.checkedAt).toBeInstanceOf(Date);
    expect(found?.checkedAt.getTime()).toBe(value.checkedAt.getTime());
  });

  it("returns undefined for a cache miss", async () => {
    const cache = createRedisDomainCache(redis);
    await expect(cache.get("never-cached.example")).resolves.toBeUndefined();
  });

  it("expires the cached entry after its TTL", async () => {
    const cache = createRedisDomainCache(redis);
    await cache.set("example.com", assessment(), 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await expect(cache.get("example.com")).resolves.toBeUndefined();
  });
});
