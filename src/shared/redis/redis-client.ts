import { Redis } from "ioredis";
import type { Logger } from "../logger/index.js";

/**
 * The narrow surface anything in this service is allowed to depend on for
 * Redis — never the full `ioredis` client type. Same boundary principle as
 * `Database`/`DatabaseClient` draw around `pg` (see src/shared/db/pool.ts)
 * and the one Stage 6 spec section 18 asks for explicitly: "do not allow
 * business/application code to depend directly on the Redis client." A real
 * `ioredis.Redis` instance satisfies this structurally; test doubles (see
 * tests/support/fake-redis.ts) implement only this, not the entire library.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: "EX", seconds: number, setMode?: "NX"): Promise<"OK" | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...keysAndArgs: readonly (string | number)[]): Promise<unknown>;
  ping(): Promise<string>;
  /** Test/ops use only — never called from application code. */
  flushdb(): Promise<string>;
  quit(): Promise<string>;
  disconnect(): void;
}

/**
 * The one place anything in this service constructs a Redis connection.
 * Application/domain code never imports `ioredis` directly — it depends on
 * `RedisClient` above.
 */
export function createRedisClient(url: string, logger: Logger): RedisClient {
  const client = new Redis(url, {
    // Fail fast rather than buffering commands indefinitely against a
    // connection that may never come back — a stuck OAuth state lookup
    // should surface as a timeout/error, not hang the request forever.
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });

  client.on("error", (error) => {
    logger.error({ err: error }, "Unexpected error on the Redis client");
  });

  // Wrapped explicitly, not returned as-is: `ioredis`'s real client type is
  // a large overloaded surface, and this keeps `RedisClient` the actual
  // contract callers type-check against rather than an incidental subset of
  // whatever `ioredis` happens to expose.
  return {
    get: (key) => client.get(key),
    set: (key, value, expiryMode, seconds, setMode) =>
      setMode ? client.set(key, value, expiryMode, seconds, setMode) : client.set(key, value, expiryMode, seconds),
    del: (key) => client.del(key),
    eval: (script, numKeys, ...keysAndArgs) => client.eval(script, numKeys, ...keysAndArgs),
    ping: () => client.ping(),
    flushdb: () => client.flushdb(),
    quit: () => client.quit(),
    disconnect: () => client.disconnect(),
  };
}

export async function checkRedisConnectivity(redis: RedisClient): Promise<boolean> {
  try {
    const reply = await redis.ping();
    return reply === "PONG";
  } catch {
    return false;
  }
}

/**
 * Startup-only variant of `checkRedisConnectivity`: keeps probing until Redis
 * answers or `timeoutMs` elapses. Redis is routinely replaced in the same
 * deploy that starts this process, so a single failed probe at boot is
 * expected, not fatal.
 */
export async function waitForRedisConnectivity(
  redis: RedisClient,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const { timeoutMs = 90_000, intervalMs = 2_000 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await checkRedisConnectivity(redis)) {
      return true;
    }
    if (Date.now() + intervalMs > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
