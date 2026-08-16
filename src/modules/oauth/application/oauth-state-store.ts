import type { OAuthStateRecord } from "../domain/oauth-state.js";

/**
 * Short-lived, single-use OAuth state storage. `infrastructure/redis-oauth-state-store.ts`
 * is the production implementation; `infrastructure/in-memory-oauth-state-store.ts`
 * exists only for fast unit tests — unlike Stage 5's in-memory credential
 * store, there is no "non-production fallback" role for it to fill, since
 * REDIS_URL is unconditionally required (see src/shared/config/schema.ts).
 *
 * `consume` deletes the record as part of retrieving it, atomically — a
 * second call with the same state, whether from a legitimate double-click
 * or a genuine replay attempt, always returns undefined. This is what makes
 * "single-use" a structural property rather than an application-level
 * convention callers have to remember to enforce.
 */
export interface OAuthStateStore {
  create(record: OAuthStateRecord): Promise<{ state: string }>;
  consume(state: string): Promise<OAuthStateRecord | undefined>;
}
