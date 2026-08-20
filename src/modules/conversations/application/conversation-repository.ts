import type { DatabaseClient } from "../../../shared/db/index.js";
import type { ConversationId, MailboxId, TenantId } from "../../../shared/types/index.js";
import type { Conversation } from "../domain/conversation.js";
import type { ConversationState } from "../domain/conversation-state.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ConversationChannel } from "../domain/conversation.js";

export interface UpsertConversationInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly channel: ConversationChannel;
  readonly provider: MailboxProviderType;
  readonly providerThreadId?: string;
  readonly syntheticThreadKey: string;
  readonly state: ConversationState;
  readonly subject?: string;
  readonly messageAt: Date;
}

export interface ConversationRepository {
  upsertBySyntheticKey(client: DatabaseClient, input: UpsertConversationInput): Promise<{ conversation: Conversation; created: boolean }>;
  findById(tenantId: TenantId, conversationId: ConversationId): Promise<Conversation | undefined>;
  listByMailbox(
    tenantId: TenantId,
    mailboxId: MailboxId,
    limit: number,
    offset: number,
  ): Promise<readonly Conversation[]>;
  updateStateAndTimestamps(
    client: DatabaseClient,
    tenantId: TenantId,
    conversationId: ConversationId,
    state: ConversationState,
    lastMessageAt: Date,
    subject?: string,
  ): Promise<Conversation>;
}
