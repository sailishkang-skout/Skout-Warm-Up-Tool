import type { ConnectionAttemptId, MailboxId, TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";

export const CONNECTION_ATTEMPT_STATUSES = [
  "STARTED",
  "AUTHORIZED",
  "VALIDATING",
  "SUCCEEDED",
  "FAILED",
  "EXPIRED",
] as const;
export type ConnectionAttemptStatus = (typeof CONNECTION_ATTEMPT_STATUSES)[number];

/**
 * Operational record of one connection attempt — purely for observability
 * ("what happened and when"), never a credential store. Deliberately never
 * holds an authorization code, access token, or refresh token — see
 * migrations/008_create_connection_attempts.sql.
 */
export interface ConnectionAttempt {
  readonly id: ConnectionAttemptId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly status: ConnectionAttemptStatus;
  readonly startedAt: Date;
  readonly completedAt?: Date;
  readonly failureReason?: string;
  readonly correlationId?: string;
}
