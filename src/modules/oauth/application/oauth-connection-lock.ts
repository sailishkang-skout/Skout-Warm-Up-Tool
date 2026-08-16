import type { MailboxId } from "../../../shared/types/index.js";

/**
 * Cheap abuse-protection primitive for OAuth initiation (Stage 6 spec
 * section 19: "OAuth initiation should have reasonable abuse protection
 * architecture," short of full API rate limiting, which is explicitly out
 * of scope this stage). Not a general-purpose distributed lock — just "at
 * most one in-flight OAuth attempt per mailbox at a time," auto-expiring so
 * a crashed or abandoned attempt can never permanently wedge a mailbox.
 * Full per-tenant/per-IP rate limiting is a documented future boundary, not
 * this stage's job (see this module's README).
 */
export interface OAuthConnectionLock {
  /** Returns true if the lock was acquired, false if another attempt is already in flight for this mailbox. */
  acquire(mailboxId: MailboxId): Promise<boolean>;
  release(mailboxId: MailboxId): Promise<void>;
}
