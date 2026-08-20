import type { DatabaseClient } from "../../../shared/db/index.js";
import type { MailboxId, MailboxInboundSyncStateId, TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";

export interface MailboxInboundSyncState {
  readonly id: MailboxInboundSyncStateId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: Extract<MailboxProviderType, "GMAIL" | "MICROSOFT365">;
  readonly cursor?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: Date;
  readonly lastSuccessAt?: Date;
  readonly lastErrorSafe?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReclaimedInboundLease {
  readonly id: MailboxInboundSyncStateId;
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
}

export interface InboundSyncStateRepository {
  ensure(tenantId: TenantId, mailboxId: MailboxId, provider: "GMAIL" | "MICROSOFT365"): Promise<MailboxInboundSyncState>;
  claimNext(leaseOwner: string, leaseDurationMs: number): Promise<MailboxInboundSyncState | undefined>;
  reclaimExpiredLeases(now: Date, limit: number): Promise<readonly ReclaimedInboundLease[]>;
  completeSuccess(client: DatabaseClient, id: MailboxInboundSyncStateId, leaseOwner: string, cursor: string | undefined): Promise<void>;
  completeFailure(id: MailboxInboundSyncStateId, leaseOwner: string, lastErrorSafe: string): Promise<void>;
  releaseLease(id: MailboxInboundSyncStateId, leaseOwner: string): Promise<void>;
}
