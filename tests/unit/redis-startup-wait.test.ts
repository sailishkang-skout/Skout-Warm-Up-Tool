import { describe, expect, it } from "vitest";
import { waitForRedisConnectivity, type RedisClient } from "../../src/shared/redis/index.js";

function redisFailingTimes(failures: number): { client: RedisClient; pings: () => number } {
  let calls = 0;
  const client = {
    ping: async () => {
      calls += 1;
      if (calls <= failures) {
        throw new Error("getaddrinfo ENOTFOUND redis");
      }
      return "PONG";
    },
  } as unknown as RedisClient;
  return { client, pings: () => calls };
}

describe("waitForRedisConnectivity", () => {
  it("succeeds once Redis comes back within the timeout", async () => {
    const { client, pings } = redisFailingTimes(3);
    await expect(waitForRedisConnectivity(client, { timeoutMs: 1_000, intervalMs: 5 })).resolves.toBe(true);
    expect(pings()).toBe(4);
  });

  it("gives up after the timeout when Redis never answers", async () => {
    const { client } = redisFailingTimes(Number.POSITIVE_INFINITY);
    await expect(waitForRedisConnectivity(client, { timeoutMs: 50, intervalMs: 10 })).resolves.toBe(false);
  });
});
