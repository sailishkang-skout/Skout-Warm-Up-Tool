import type { DatabaseClient } from "../../../shared/db/index.js";
import {
  asConversationId,
  asMailboxId,
  asTenantId,
  type ConversationId,
  type MailboxId,
  type TenantId,
} from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { Conversation, ConversationChannel } from "../domain/conversation.js";
import type { ConversationState } from "../domain/conversation-state.js";
import type { ConversationRepository, UpsertConversationInput } from "../application/conversation-repository.js";

interface ConversationRow {
  id: string;
  tenant_id: string;
  mailbox_id: string;
  channel: ConversationChannel;
  provider: MailboxProviderType;
  provider_thread_id: string | null;
  synthetic_thread_key: string;
  state: ConversationState;
  subject: string | null;
  first_message_at: Date;
  last_message_at: Date;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, mailbox_id, channel, provider, provider_thread_id, synthetic_thread_key,
  state, subject, first_message_at, last_message_at, created_at, updated_at
`;

function mapRow(row: ConversationRow): Conversation {
  return {
    id: asConversationId(row.id),
    tenantId: asTenantId(row.tenant_id),
    mailboxId: asMailboxId(row.mailbox_id),
    channel: row.channel,
    provider: row.provider,
    ...(row.provider_thread_id ? { providerThreadId: row.provider_thread_id } : {}),
    syntheticThreadKey: row.synthetic_thread_key,
    state: row.state,
    ...(row.subject ? { subject: row.subject } : {}),
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly db: DatabaseClient) {}

  async upsertBySyntheticKey(client: DatabaseClient, input: UpsertConversationInput): Promise<{ conversation: Conversation; created: boolean }> {
    const inserted = await client.query<ConversationRow>(
      `INSERT INTO conversations (
         tenant_id, mailbox_id, channel, provider, provider_thread_id, synthetic_thread_key,
         state, subject, first_message_at, last_message_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (tenant_id, mailbox_id, synthetic_thread_key) DO NOTHING
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.tenantId,
        input.mailboxId,
        input.channel,
        input.provider,
        input.providerThreadId ?? null,
        input.syntheticThreadKey,
        input.state,
        input.subject ?? null,
        input.messageAt,
      ],
    );
    if (inserted[0]) {
      return { conversation: mapRow(inserted[0]), created: true };
    }
    const existing = await client.query<ConversationRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversations
       WHERE tenant_id = $1 AND mailbox_id = $2 AND synthetic_thread_key = $3`,
      [input.tenantId, input.mailboxId, input.syntheticThreadKey],
    );
    return { conversation: mapRow(existing[0]!), created: false };
  }

  async findById(tenantId: TenantId, conversationId: ConversationId): Promise<Conversation | undefined> {
    const rows = await this.db.query<ConversationRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversations WHERE tenant_id = $1 AND id = $2`,
      [tenantId, conversationId],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async listByMailbox(tenantId: TenantId, mailboxId: MailboxId, limit: number, offset: number): Promise<readonly Conversation[]> {
    const rows = await this.db.query<ConversationRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversations
       WHERE tenant_id = $1 AND mailbox_id = $2
       ORDER BY last_message_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [tenantId, mailboxId, limit, offset],
    );
    return rows.map(mapRow);
  }

  async updateStateAndTimestamps(
    client: DatabaseClient,
    tenantId: TenantId,
    conversationId: ConversationId,
    state: ConversationState,
    lastMessageAt: Date,
    subject?: string,
  ): Promise<Conversation> {
    const rows = await client.query<ConversationRow>(
      `UPDATE conversations
       SET state = $3,
           last_message_at = GREATEST(last_message_at, $4),
           subject = COALESCE(subject, $5)
       WHERE tenant_id = $1 AND id = $2
       RETURNING ${SELECT_COLUMNS}`,
      [tenantId, conversationId, state, lastMessageAt, subject ?? null],
    );
    return mapRow(rows[0]!);
  }
}
