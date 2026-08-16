/**
 * Requires a live Redis instance. Run via `npm run test:db` (`docker
 * compose up -d` brings up Redis alongside Postgres). Exercises the real
 * Redis-backed OAuth state store and connection lock — no mocked Redis
 * behavior.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRedisOAuthConnectionLock } from "../../src/modules/oauth/infrastructure/redis-oauth-connection-lock.js";
import { createRedisOAuthStateStore } from "../../src/modules/oauth/infrastructure/redis-oauth-state-store.js";
import { asMailboxId, asTenantId } from "../../src/shared/types/index.js";
import type { OAuthStateRecord } from "../../src/modules/oauth/domain/oauth-state.js";
import { createTestRedisHandle, flushTestRedis } from "./support.js";

const redis = createTestRedisHandle();

const RECORD: OAuthStateRecord = {
  tenantId: asTenantId("11111111-1111-1111-1111-111111111111"),
  mailboxId: asMailboxId("22222222-2222-2222-2222-222222222222"),
  provider: "GMAIL",
  codeVerifier: "verifier-value",
};

beforeEach(async () => {
  await flushTestRedis(redis);
});

afterAll(() => {
  redis.disconnect();
});

describe("createRedisOAuthStateStore", () => {
  it("round-trips a created record", async () => {
    const store = createRedisOAuthStateStore(redis);
    const { state } = await store.create(RECORD);
    await expect(store.consume(state)).resolves.toEqual(RECORD);
  });

  it("is single-use — a concurrent replay of the same state loses (only one caller gets the record)", async () => {
    const store = createRedisOAuthStateStore(redis);
    const { state } = await store.create(RECORD);

    const [first, second] = await Promise.all([store.consume(state), store.consume(state)]);
    const results = [first, second];
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
  });

  it("returns undefined for an unknown state", async () => {
    const store = createRedisOAuthStateStore(redis);
    await expect(store.consume("totally-unknown-state")).resolves.toBeUndefined();
  });

  it("does not store the raw state token as the Redis key (defense in depth)", async () => {
    const store = createRedisOAuthStateStore(redis);
    const { state } = await store.create(RECORD);
    const keys = await redis.eval("return redis.call('KEYS', 'oauth:state:*')", 0);
    expect(Array.isArray(keys) ? keys.join(",") : String(keys)).not.toContain(state);
  });
});

describe("createRedisOAuthConnectionLock", () => {
  it("acquire succeeds once, fails while held, and release lets it be re-acquired", async () => {
    const lock = createRedisOAuthConnectionLock(redis);
    const mailboxId = RECORD.mailboxId;

    await expect(lock.acquire(mailboxId)).resolves.toBe(true);
    await expect(lock.acquire(mailboxId)).resolves.toBe(false);

    await lock.release(mailboxId);
    await expect(lock.acquire(mailboxId)).resolves.toBe(true);
  });

  it("locks for different mailboxes are independent", async () => {
    const lock = createRedisOAuthConnectionLock(redis);
    const mailboxA = asMailboxId("33333333-3333-3333-3333-333333333333");
    const mailboxB = asMailboxId("44444444-4444-4444-4444-444444444444");

    await expect(lock.acquire(mailboxA)).resolves.toBe(true);
    await expect(lock.acquire(mailboxB)).resolves.toBe(true);
  });
});
