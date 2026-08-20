import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { Database, DatabaseClient } from "../../../shared/db/index.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import type { ConversationId, MailboxId, TenantId } from "../../../shared/types/index.js";
import { computeSyntheticThreadKey, type Conversation } from "../domain/conversation.js";
import { initialConversationState, transitionConversationState } from "../domain/conversation-state.js";
import {
  computeMessageDedupeKey,
  truncateTextBody,
  type ConversationMessage,
} from "../domain/conversation-message.js";
import type { NormalizedInbound } from "../domain/normalized-inbound.js";
import type { ConversationRepository } from "./conversation-repository.js";
import type { ConversationMessageRepository } from "./conversation-message-repository.js";
import type { ClassificationRepository } from "./classification-repository.js";
import type { WarmupExecutionIntentId } from "../../../shared/types/index.js";
import { CLASSIFICATION_TAXONOMY_VERSION } from "../domain/classification-taxonomy.js";

export interface PersistNormalizedResult {
  readonly conversation: Conversation;
  readonly message: ConversationMessage;
  readonly conversationCreated: boolean;
  readonly messageInserted: boolean;
}

export interface ConversationService {
  persistNormalized(
    tenantId: TenantId,
    mailboxId: MailboxId,
    normalized: NormalizedInbound,
    executionIntentId?: WarmupExecutionIntentId,
  ): Promise<PersistNormalizedResult>;
  persistOnClient(
    client: DatabaseClient,
    tenantId: TenantId,
    mailboxId: MailboxId,
    normalized: NormalizedInbound,
    executionIntentId?: WarmupExecutionIntentId,
  ): Promise<PersistNormalizedResult>;
  emitPersistAudits(result: PersistNormalizedResult): Promise<void>;
  getConversation(tenantId: TenantId, conversationId: ConversationId): Promise<Conversation>;
  listConversations(tenantId: TenantId, mailboxId: MailboxId, limit: number, offset: number): Promise<readonly Conversation[]>;
  listMessages(tenantId: TenantId, conversationId: ConversationId, limit: number, offset: number): Promise<readonly ConversationMessage[]>;
}

export interface CreateConversationServiceDeps {
  readonly database: Database;
  readonly mailboxService: MailboxService;
  readonly conversationRepository: ConversationRepository;
  readonly messageRepository: ConversationMessageRepository;
  readonly auditRecorder: AuditEventRecorder;
  readonly classificationRepository?: ClassificationRepository;
  readonly classifierVersion?: string;
  readonly taxonomyVersion?: string;
}

export function createConversationService(deps: CreateConversationServiceDeps): ConversationService {
  const {
    database,
    mailboxService,
    conversationRepository,
    messageRepository,
    auditRecorder,
    classificationRepository,
    classifierVersion,
    taxonomyVersion = CLASSIFICATION_TAXONOMY_VERSION,
  } = deps;

    async function emitPersistAudits(result: PersistNormalizedResult): Promise<void> {
      const { conversation, message, conversationCreated, messageInserted } = result;
      if (conversationCreated) {
        await auditRecorder.record({
          tenantId: conversation.tenantId,
          eventType: "CONVERSATION_CREATED",
          actorType: "system",
          metadata: {
            conversationId: conversation.id,
            mailboxId: conversation.mailboxId,
            provider: conversation.provider,
            state: conversation.state,
          },
        });
      } else if (messageInserted) {
        await auditRecorder.record({
          tenantId: conversation.tenantId,
          eventType: "CONVERSATION_UPDATED",
          actorType: "system",
          metadata: {
            conversationId: conversation.id,
            mailboxId: conversation.mailboxId,
            provider: conversation.provider,
            state: conversation.state,
          },
        });
      }

      if (messageInserted) {
        await auditRecorder.record({
          tenantId: conversation.tenantId,
          eventType: message.direction === "OUTBOUND" ? "MESSAGE_SENT" : "MESSAGE_RECEIVED",
          actorType: "system",
          metadata: {
            conversationId: conversation.id,
            messageId: message.id,
            mailboxId: conversation.mailboxId,
            provider: conversation.provider,
            direction: message.direction,
          },
        });
      }
    }

    async function persistWithClient(
    tenantId: TenantId,
    mailboxId: MailboxId,
    normalized: NormalizedInbound,
    executionIntentId: WarmupExecutionIntentId | undefined,
    run: <T>(fn: (client: Parameters<ConversationRepository["upsertBySyntheticKey"]>[0]) => Promise<T>) => Promise<T>,
    emitAudit: boolean,
  ): Promise<PersistNormalizedResult> {
    await mailboxService.getMailbox(tenantId, mailboxId);

    const textBody = truncateTextBody(normalized.textBody);
    const dedupeKey = computeMessageDedupeKey({
      tenantId,
      mailboxId,
      provider: normalized.provider,
      direction: normalized.direction,
      sentAt: normalized.sentAt,
      sender: normalized.sender,
      ...(normalized.subject ? { subject: normalized.subject } : {}),
      ...(normalized.providerMessageId ? { providerMessageId: normalized.providerMessageId } : {}),
      ...(normalized.rfcMessageId ? { rfcMessageId: normalized.rfcMessageId } : {}),
    });
    const syntheticThreadKey = computeSyntheticThreadKey({
      provider: normalized.provider,
      ...(normalized.providerThreadId ? { providerThreadId: normalized.providerThreadId } : {}),
      ...(normalized.providerMessageId ? { providerMessageId: normalized.providerMessageId } : {}),
      ...(normalized.rfcMessageId ? { rfcMessageId: normalized.rfcMessageId } : {}),
      ...(dedupeKey ? { dedupeKey } : {}),
    });
    const command = normalized.direction === "OUTBOUND" ? "RECORD_OUTBOUND" : "RECORD_INBOUND";

    const result = await run(async (client) => {
      const upserted = await conversationRepository.upsertBySyntheticKey(client, {
        tenantId,
        mailboxId,
        channel: "EMAIL",
        provider: normalized.provider,
        ...(normalized.providerThreadId ? { providerThreadId: normalized.providerThreadId } : {}),
        syntheticThreadKey,
        state: initialConversationState(normalized.direction),
        ...(normalized.subject ? { subject: normalized.subject } : {}),
        messageAt: normalized.sentAt,
      });

      const nextState = upserted.created
        ? upserted.conversation.state
        : transitionConversationState(upserted.conversation.state, command);

      const inserted = await messageRepository.insertIfAbsent(client, {
        tenantId,
        mailboxId,
        conversationId: upserted.conversation.id,
        provider: normalized.provider,
        direction: normalized.direction,
        sender: normalized.sender,
        recipients: normalized.recipients,
        sentAt: normalized.sentAt,
        ...(normalized.providerMessageId ? { providerMessageId: normalized.providerMessageId } : {}),
        ...(normalized.rfcMessageId ? { rfcMessageId: normalized.rfcMessageId } : {}),
        ...(normalized.inReplyTo ? { inReplyTo: normalized.inReplyTo } : {}),
        ...(normalized.references ? { references: normalized.references } : {}),
        ...(normalized.subject ? { subject: normalized.subject } : {}),
        ...(textBody ? { textBody } : {}),
        ...(executionIntentId ? { executionIntentId } : {}),
        ...(dedupeKey ? { dedupeKey } : {}),
      });

      let conversation = upserted.conversation;
      if (inserted.inserted) {
        conversation = await conversationRepository.updateStateAndTimestamps(
          client,
          tenantId,
          upserted.conversation.id,
          nextState,
          normalized.sentAt,
          normalized.subject,
        );
        if (classificationRepository && classifierVersion) {
          await classificationRepository.enqueueOnClient(client, {
            tenantId,
            conversationId: upserted.conversation.id,
            messageId: inserted.message.id,
            classifierVersion,
            taxonomyVersion,
          });
        }
      }

      return {
        conversation,
        message: inserted.message,
        conversationCreated: upserted.created,
        messageInserted: inserted.inserted,
      };
    });

    if (emitAudit) {
      await emitPersistAudits(result);
    }

    return result;
  }

  return {
    persistNormalized(tenantId, mailboxId, normalized, executionIntentId) {
      return persistWithClient(tenantId, mailboxId, normalized, executionIntentId, (fn) => database.withTransaction(fn), true);
    },

    persistOnClient(client, tenantId, mailboxId, normalized, executionIntentId) {
      return persistWithClient(tenantId, mailboxId, normalized, executionIntentId, async (fn) => fn(client), false);
    },

    emitPersistAudits,

    async getConversation(tenantId, conversationId) {
      const conversation = await conversationRepository.findById(tenantId, conversationId);
      if (!conversation) {
        throw new NotFoundError("Conversation not found");
      }
      return conversation;
    },

    async listConversations(tenantId, mailboxId, limit, offset) {
      await mailboxService.getMailbox(tenantId, mailboxId);
      return conversationRepository.listByMailbox(tenantId, mailboxId, limit, offset);
    },

    async listMessages(tenantId, conversationId, limit, offset) {
      await this.getConversation(tenantId, conversationId);
      return messageRepository.listByConversation(tenantId, conversationId, limit, offset);
    },
  };
}
