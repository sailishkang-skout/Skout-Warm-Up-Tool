import type { DatabaseClient } from "../../../shared/db/index.js";
import {
  asConversationId,
  asMailboxId,
  asMessageId,
  asTenantId,
  asWarmupExecutionIntentId,
  type ConversationId,
  type MailboxId,
  type TenantId,
  type WarmupExecutionIntentId,
} from "../../../shared/types/index.js";
import { sanitizeForLogging } from "../../../shared/logger/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ConversationMessage, MessageDirection } from "../domain/conversation-message.js";
import type {
  ConversationMessageRepository,
  InsertConversationMessageInput,
} from "../application/conversation-message-repository.js";

interface MessageRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  conversation_id: string;
  provider: MailboxProviderType;
  direction: MessageDirection;
  provider_message_id: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  sender: string;
  recipients: unknown;
  subject: string | null;
  text_body: string | null;
  html_body: string | null;
  sent_at: Date;
  execution_intent_id: string | null;
  metadata: Record<string, unknown>;
  dedupe_key: string | null;
  created_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, mailbox_id, conversation_id, provider, direction, provider_message_id,
  rfc_message_id, in_reply_to, "references", sender, recipients, subject, text_body, html_body,
  sent_at, execution_intent_id, metadata, dedupe_key, created_at
`;

function mapRow(row: MessageRow): ConversationMessage {
  const recipients = Array.isArray(row.recipients) ? row.recipients.filter((item): item is string => typeof item === "string") : [];
  return {
    id: asMessageId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    conversationId: asConversationId(row.conversation_id),
    provider: row.provider,
    direction: row.direction,
    ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
    ...(row.rfc_message_id ? { rfcMessageId: row.rfc_message_id } : {}),
    ...(row.in_reply_to ? { inReplyTo: row.in_reply_to } : {}),
    ...(row.references ? { references: row.references } : {}),
    sender: row.sender,
    recipients,
    ...(row.subject ? { subject: row.subject } : {}),
    ...(row.text_body ? { textBody: row.text_body } : {}),
    ...(row.html_body ? { htmlBody: row.html_body } : {}),
    sentAt: row.sent_at,
    ...(row.execution_intent_id ? { executionIntentId: asWarmupExecutionIntentId(row.execution_intent_id) } : {}),
    metadata: row.metadata ?? {},
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    createdAt: row.created_at,
  };
}

export class PostgresConversationMessageRepository implements ConversationMessageRepository {
  constructor(private readonly db: DatabaseClient) {}

  async insertIfAbsent(
    client: DatabaseClient,
    input: InsertConversationMessageInput,
  ): Promise<{ message: ConversationMessage; inserted: boolean }> {
    const safeMetadata = sanitizeForLogging(input.metadata ?? {});
    const inserted = await client.query<MessageRow>(
      `INSERT INTO conversation_messages (
         tenant_id, mailbox_id, conversation_id, provider, direction, provider_message_id,
         rfc_message_id, in_reply_to, "references", sender, recipients, subject, text_body, html_body,
         sent_at, execution_intent_id, metadata, dedupe_key
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,NULL,$14,$15,$16::jsonb,$17)
       ON CONFLICT DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.mailboxId,
        input.conversationId,
        input.provider,
        input.direction,
        input.providerMessageId ?? null,
        input.rfcMessageId ?? null,
        input.inReplyTo ?? null,
        input.references ?? null,
        input.sender,
        JSON.stringify(input.recipients),
        input.subject ?? null,
        input.textBody ?? null,
        input.sentAt,
        input.executionIntentId ?? null,
        JSON.stringify(safeMetadata),
        input.dedupeKey ?? null,
      ],
    );
    if (inserted[0]) {
      return { message: mapRow(inserted[0]), inserted: true };
    }

    const existing = await this.findExisting(client, input);
    return { message: existing!, inserted: false };
  }

  async listByConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
  ): Promise<readonly ConversationMessage[]> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversation_messages
       WHERE tenant_id = $1 AND conversation_id = $2
       ORDER BY sent_at ASC, created_at ASC, id ASC
       LIMIT $3 OFFSET $4`,
      [tenantId, conversationId, limit, offset],
    );
    return rows.map(mapRow);
  }

  async findByProviderMessageId(
    tenantId: TenantId,
    mailboxId: MailboxId,
    provider: MailboxProviderType,
    providerMessageId: string,
  ): Promise<ConversationMessage | undefined> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversation_messages
       WHERE tenant_id = $1 AND mailbox_id = $2 AND provider = $3 AND provider_message_id = $4`,
      [tenantId, mailboxId, provider, providerMessageId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async findByExecutionIntentId(tenantId: TenantId, executionIntentId: WarmupExecutionIntentId): Promise<ConversationMessage | undefined> {
    const rows = await this.db.query<MessageRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversation_messages
       WHERE tenant_id = $1 AND execution_intent_id = $2`,
      [tenantId, executionIntentId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async linkExecutionIntent(
    tenantId: TenantId,
    messageId: ConversationMessage["id"],
    executionIntentId: WarmupExecutionIntentId,
  ): Promise<void> {
    await this.db.query(
      `UPDATE conversation_messages SET execution_intent_id = $3
       WHERE tenant_id = $1 AND id = $2 AND execution_intent_id IS NULL`,
      [tenantId, messageId, executionIntentId],
    );
  }

  private async findExisting(client: DatabaseClient, input: InsertConversationMessageInput): Promise<ConversationMessage | undefined> {
    if (input.providerMessageId) {
      const rows = await client.query<MessageRow>(
        `SELECT ${SELECT_COLUMNS} FROM conversation_messages
         WHERE tenant_id = $1 AND mailbox_id = $2 AND provider = $3 AND provider_message_id = $4`,
        [input.tenantId, input.mailboxId, input.provider, input.providerMessageId],
      );
      if (rows[0]) return mapRow(rows[0]);
    }
    if (input.rfcMessageId) {
      const rows = await client.query<MessageRow>(
        `SELECT ${SELECT_COLUMNS} FROM conversation_messages
         WHERE tenant_id = $1 AND mailbox_id = $2 AND provider = $3 AND rfc_message_id = $4`,
        [input.tenantId, input.mailboxId, input.provider, input.rfcMessageId],
      );
      if (rows[0]) return mapRow(rows[0]);
    }
    if (input.dedupeKey) {
      const rows = await client.query<MessageRow>(
        `SELECT ${SELECT_COLUMNS} FROM conversation_messages WHERE dedupe_key = $1`,
        [input.dedupeKey],
      );
      if (rows[0]) return mapRow(rows[0]);
    }
    return undefined;
  }
}
