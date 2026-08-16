import type { ConnectionAttemptId, MailboxId, TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ConnectionAttempt, ConnectionAttemptStatus } from "../domain/connection-attempt.js";

export interface CreateConnectionAttemptInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly correlationId?: string;
}

export interface UpdateConnectionAttemptStatusInput {
  readonly status: ConnectionAttemptStatus;
  readonly failureReason?: string;
  /** Set true once the attempt reaches a terminal state, to stamp `completed_at`. */
  readonly completed?: boolean;
}

/** Port implemented by `infrastructure/postgres-connection-attempt-repository.ts`. */
export interface ConnectionAttemptRepository {
  create(input: CreateConnectionAttemptInput): Promise<ConnectionAttempt>;
  updateStatus(
    id: ConnectionAttemptId,
    input: UpdateConnectionAttemptStatusInput,
  ): Promise<ConnectionAttempt | undefined>;
  /** The most recent still-in-flight (STARTED/AUTHORIZED/VALIDATING) attempt for a mailbox, if any. */
  findActiveByMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<ConnectionAttempt | undefined>;
}
