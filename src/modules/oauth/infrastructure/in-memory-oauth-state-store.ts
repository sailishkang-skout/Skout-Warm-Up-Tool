import { randomBytes } from "node:crypto";
import type { OAuthStateStore } from "../application/oauth-state-store.js";
import type { OAuthStateRecord } from "../domain/oauth-state.js";

const STATE_TTL_MS = 600_000; // 10 minutes, matching redis-oauth-state-store.ts

interface StoredEntry {
  readonly record: OAuthStateRecord;
  readonly expiresAt: number;
}

/**
 * Test double only — mirrors `redis-oauth-state-store.ts`'s single-use/TTL
 * semantics without a real Redis. Never used by the composition root:
 * REDIS_URL is unconditionally required (see src/shared/config/schema.ts),
 * so production always has the real store; this exists purely so unit
 * tests can exercise `OAuthConnectionService` without infrastructure.
 *
 * `ttlMs` defaults to the production value but is overridable so a test can
 * exercise expiry without an actual 10-minute wait.
 */
export function createInMemoryOAuthStateStore(ttlMs: number = STATE_TTL_MS): OAuthStateStore {
  const entries = new Map<string, StoredEntry>();

  return {
    async create(record: OAuthStateRecord): Promise<{ state: string }> {
      const state = randomBytes(32).toString("base64url");
      entries.set(state, { record, expiresAt: Date.now() + ttlMs });
      return { state };
    },

    async consume(state: string): Promise<OAuthStateRecord | undefined> {
      const entry = entries.get(state);
      entries.delete(state);
      if (!entry || entry.expiresAt <= Date.now()) {
        return undefined;
      }
      return entry.record;
    },
  };
}
