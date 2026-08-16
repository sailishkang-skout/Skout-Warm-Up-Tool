import type { MailboxId } from "../../../shared/types/index.js";
import type { RedisClient } from "../../../shared/redis/index.js";
import type { OAuthConnectionLock } from "../application/oauth-connection-lock.js";

// Long enough for a real OAuth round trip (redirect to provider, user
// consent, redirect back), short enough that a crashed/abandoned attempt
// self-heals quickly rather than wedging the mailbox for hours.
const LOCK_TTL_SECONDS = 300;
const KEY_PREFIX = "oauth:lock:mailbox:";

export function createRedisOAuthConnectionLock(redis: RedisClient): OAuthConnectionLock {
  return {
    async acquire(mailboxId: MailboxId): Promise<boolean> {
      const result = await redis.set(KEY_PREFIX + mailboxId, "1", "EX", LOCK_TTL_SECONDS, "NX");
      return result === "OK";
    },
    async release(mailboxId: MailboxId): Promise<void> {
      await redis.del(KEY_PREFIX + mailboxId);
    },
  };
}
