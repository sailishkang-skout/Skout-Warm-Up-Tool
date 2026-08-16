import type { MailboxId } from "../../../shared/types/index.js";
import type { OAuthConnectionLock } from "../application/oauth-connection-lock.js";

/** Test double only — see in-memory-oauth-state-store.ts for why production always uses the Redis implementation. */
export function createInMemoryOAuthConnectionLock(): OAuthConnectionLock {
  const locked = new Set<MailboxId>();

  return {
    async acquire(mailboxId: MailboxId): Promise<boolean> {
      if (locked.has(mailboxId)) {
        return false;
      }
      locked.add(mailboxId);
      return true;
    },
    async release(mailboxId: MailboxId): Promise<void> {
      locked.delete(mailboxId);
    },
  };
}
