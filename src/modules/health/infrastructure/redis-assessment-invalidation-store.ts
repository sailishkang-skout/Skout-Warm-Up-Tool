import type { RedisClient } from "../../../shared/redis/index.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { AssessmentInvalidationStore } from "../application/assessment-invalidation-store.js";

const KEY_PREFIX = "health:assessment-stale:";

// Self-expires even if `clear` is never called for some reason (a crashed
// refresh, a deploy mid-flight) — defense in depth so a stuck marker can
// never force full recomputation forever; it just falls back to the
// existing time-based freshness window instead.
const MARKER_TTL_SECONDS = 24 * 60 * 60;

function key(tenantId: TenantId, mailboxId: MailboxId): string {
  return `${KEY_PREFIX}${tenantId}:${mailboxId}`;
}

export function createRedisAssessmentInvalidationStore(redis: RedisClient): AssessmentInvalidationStore {
  return {
    async markStale(tenantId: TenantId, mailboxId: MailboxId): Promise<void> {
      await redis.set(key(tenantId, mailboxId), "1", "EX", MARKER_TTL_SECONDS);
    },
    async isStale(tenantId: TenantId, mailboxId: MailboxId): Promise<boolean> {
      return (await redis.get(key(tenantId, mailboxId))) !== null;
    },
    async clear(tenantId: TenantId, mailboxId: MailboxId): Promise<void> {
      await redis.del(key(tenantId, mailboxId));
    },
  };
}
