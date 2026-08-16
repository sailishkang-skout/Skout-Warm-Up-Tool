import type { RedisClient } from "../../src/shared/redis/index.js";

export interface FakeRedisOptions {
  readonly connected?: boolean;
}

/**
 * A `RedisClient` double for tests that exercise HTTP routing/wiring (e.g.
 * the /readiness branch logic) without a real Redis connection. Real
 * OAuth-state/lock behavior is deliberately never faked here — see
 * tests/db/ for that, which runs against actual Redis.
 */
export function createFakeRedis(options: FakeRedisOptions = {}): RedisClient {
  const connected = options.connected ?? true;
  const store = new Map<string, string>();

  return {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, _expiryMode: "EX", _seconds: number, setMode?: "NX"): Promise<"OK" | null> {
      if (setMode === "NX" && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return "OK";
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
    async eval(): Promise<unknown> {
      throw new Error("createFakeRedis: eval() is not supported by this test double");
    },
    async ping(): Promise<string> {
      if (!connected) {
        throw new Error("createFakeRedis: not connected");
      }
      return "PONG";
    },
    async flushdb(): Promise<string> {
      store.clear();
      return "OK";
    },
    async quit(): Promise<string> {
      return "OK";
    },
    disconnect(): void {
      // no-op
    },
  };
}
