import { createHash, randomBytes } from "node:crypto";
import type { RedisClient } from "../../../shared/redis/index.js";
import type { OAuthStateStore } from "../application/oauth-state-store.js";
import type { OAuthStateRecord } from "../domain/oauth-state.js";

const STATE_TTL_SECONDS = 600; // 10 minutes
const KEY_PREFIX = "oauth:state:";

// Atomic get-and-delete: guarantees single-use even under a concurrent
// replay attempt racing the legitimate callback for the same state — a
// plain GET followed by a DEL would have a check-then-act window where both
// requests could observe the value before either deletes it.
const CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

function keyFor(state: string): string {
  // The Redis key is derived from a hash of the state token, never the raw
  // token itself — defense in depth so a Redis `KEYS`/`SCAN`/slow-log leak
  // doesn't hand out live, usable state tokens verbatim.
  return KEY_PREFIX + createHash("sha256").update(state).digest("hex");
}

/**
 * Production OAuth state storage. `state` is a cryptographically random,
 * unguessable 256-bit token — nothing about it is derived from or
 * predictable from tenant/mailbox/provider identifiers.
 */
export function createRedisOAuthStateStore(redis: RedisClient): OAuthStateStore {
  return {
    async create(record: OAuthStateRecord): Promise<{ state: string }> {
      const state = randomBytes(32).toString("base64url");
      await redis.set(keyFor(state), JSON.stringify(record), "EX", STATE_TTL_SECONDS);
      return { state };
    },

    async consume(state: string): Promise<OAuthStateRecord | undefined> {
      const raw = (await redis.eval(CONSUME_SCRIPT, 1, keyFor(state))) as string | null;
      return raw ? (JSON.parse(raw) as OAuthStateRecord) : undefined;
    },
  };
}
