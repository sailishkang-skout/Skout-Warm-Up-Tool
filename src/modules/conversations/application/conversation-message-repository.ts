import type { DatabaseClient } from "../../../shared/db/index.js";
import type { ConversationId, MailboxId, TenantId, WarmupExecutionIntentId } from "../../../shared/types/index.js";
import type { ConversationMessage, MessageDirection } from "../domain/conversation-message.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";

export interface InsertConversationMessageInput {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly conversationId: ConversationId;
  readonly provider: MailboxProviderType;
  readonly direction: MessageDirection;
  readonly providerMessageId?: string;
  readonly rfcMessageId?: string;
  readonly inReplyTo?: string;
  readonly references?: string;
  readonly sender: string;
  readonly recipients: readonly string[];
  readonly subject?: string;
  readonly textBody?: string;
  readonly sentAt: Date;
  readonly executionIntentId?: WarmupExecutionIntentId;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly dedupeKey?: string;
}

export interface ConversationMessageRepository {
  insertIfAbsent(
    client: DatabaseClient,
    input: InsertConversationMessageInput,
  ): Promise<{ message: ConversationMessage; inserted: boolean }>;
  listByConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
  ): Promise<readonly ConversationMessage[]>;
  findByProviderMessageId(
    tenantId: TenantId,
    mailboxId: MailboxId,
    provider: MailboxProviderType,
    providerMessageId: string,
  ): Promise<ConversationMessage | undefined>;
  findByExecutionIntentId(tenantId: TenantId, executionIntentId: WarmupExecutionIntentId): Promise<ConversationMessage | undefined>;
  linkExecutionIntent(
    tenantId: TenantId,
    messageId: ConversationMessage["id"],
    executionIntentId: WarmupExecutionIntentId,
  ): Promise<void>;
}
