import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import { asConversationId, asMailboxId, asMessageId, type TenantId } from "../../../shared/types/index.js";
import type { ConversationService } from "../application/conversation-service.js";
import type { ClassificationQueryService } from "../application/classification-worker.js";
import type { ConversationPolicyQueryService } from "../application/policy-evaluation-worker.js";
import type { Conversation } from "../domain/conversation.js";
import type { ConversationMessage } from "../domain/conversation-message.js";
import type { MessageClassification } from "../domain/classification.js";
import { isClassificationLabel } from "../domain/classification-taxonomy.js";
import { isDomainFactType, type ConversationDomainFact } from "../domain/domain-facts.js";
import { isPolicySignalType } from "../domain/policy-signal-taxonomy.js";
import type { ConversationPolicySignal } from "../domain/policy-result.js";
import type { ConversationClassificationFacts } from "../domain/conversation-facts.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

const listQuerySchema = z.object({
  mailboxId: z.string().regex(UUID_PATTERN, "Invalid mailbox id"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const classificationListQuerySchema = pageQuerySchema.extend({
  label: z.string().min(1).optional(),
});

const domainFactListQuerySchema = pageQuerySchema.extend({
  label: z.string().min(1).optional(),
});

const policySignalListQuerySchema = pageQuerySchema.extend({
  signal: z.string().min(1).optional(),
});

function toSafeConversation(conversation: Conversation) {
  return {
    id: conversation.id,
    mailboxId: conversation.mailboxId,
    channel: conversation.channel,
    provider: conversation.provider,
    state: conversation.state,
    ...(conversation.providerThreadId ? { providerThreadId: conversation.providerThreadId } : {}),
    syntheticThreadKey: conversation.syntheticThreadKey,
    ...(conversation.subject ? { subject: conversation.subject } : {}),
    firstMessageAt: conversation.firstMessageAt.toISOString(),
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

function toSafeMessage(message: ConversationMessage) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    mailboxId: message.mailboxId,
    provider: message.provider,
    direction: message.direction,
    ...(message.providerMessageId ? { providerMessageId: message.providerMessageId } : {}),
    ...(message.rfcMessageId ? { rfcMessageId: message.rfcMessageId } : {}),
    ...(message.inReplyTo ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references ? { references: message.references } : {}),
    sender: message.sender,
    recipients: message.recipients,
    ...(message.subject ? { subject: message.subject } : {}),
    ...(message.textBody ? { textBody: message.textBody } : {}),
    sentAt: message.sentAt.toISOString(),
    ...(message.executionIntentId ? { executionIntentId: message.executionIntentId } : {}),
    createdAt: message.createdAt.toISOString(),
  };
}

function toSafeClassification(classification: MessageClassification) {
  return {
    id: classification.id,
    conversationId: classification.conversationId,
    messageId: classification.messageId,
    classifierVersion: classification.classifierVersion,
    taxonomyVersion: classification.taxonomyVersion,
    ...(classification.classifierType ? { classifierType: classification.classifierType } : {}),
    status: classification.status,
    labels: classification.labels,
    ...(classification.primaryLabel ? { primaryLabel: classification.primaryLabel } : {}),
    ...(classification.confidence !== undefined ? { confidence: classification.confidence } : {}),
    ...(classification.confidenceBand ? { confidenceBand: classification.confidenceBand } : {}),
    ...(classification.reason ? { reason: classification.reason } : {}),
    evidence: classification.evidence,
    createdAt: classification.createdAt.toISOString(),
    updatedAt: classification.updatedAt.toISOString(),
  };
}

function toSafeFacts(facts: ConversationClassificationFacts) {
  return {
    conversationId: facts.conversationId,
    labels: facts.labels,
    ...(facts.primaryLabel ? { primaryLabel: facts.primaryLabel } : {}),
    needsHumanReview: facts.needsHumanReview,
    ...(facts.lastClassifiedMessageId ? { lastClassifiedMessageId: facts.lastClassifiedMessageId } : {}),
    lastClassifiedAt: facts.lastClassifiedAt.toISOString(),
    updatedAt: facts.updatedAt.toISOString(),
  };
}

function toSafeDomainFact(fact: ConversationDomainFact) {
  return {
    id: fact.id,
    conversationId: fact.conversationId,
    messageId: fact.messageId,
    factType: fact.factType,
    classifierVersion: fact.classifierVersion,
    taxonomyVersion: fact.taxonomyVersion,
    evidence: fact.evidence,
    createdAt: fact.createdAt.toISOString(),
  };
}

function toSafePolicySignal(signal: ConversationPolicySignal) {
  return {
    id: signal.id,
    conversationId: signal.conversationId,
    policyEvaluationId: signal.policyEvaluationId,
    ...(signal.sourceMessageId ? { sourceMessageId: signal.sourceMessageId } : {}),
    signal: signal.signal,
    priority: signal.priority,
    ...(signal.sourceFactType ? { source: signal.sourceFactType } : {}),
    ...(signal.sourceFactId ? { sourceFactId: signal.sourceFactId } : {}),
    policyVersion: signal.policyVersion,
    createdAt: signal.createdAt.toISOString(),
  };
}

export function conversationRoutes(
  conversationService: ConversationService,
  classificationQuery: ClassificationQueryService,
  policyQuery: ConversationPolicyQueryService,
): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get("/", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ValidationError("Invalid conversation list query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const conversations = await conversationService.listConversations(
        tenantId,
        asMailboxId(parsed.data.mailboxId),
        parsed.data.limit,
        parsed.data.offset,
      );
      return { conversations: conversations.map(toSafeConversation) };
    });

    fastify.get("/:id", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const { id } = request.params as { id: string };
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError("Invalid conversation id");
      }
      const conversation = await conversationService.getConversation(tenantId, asConversationId(id));
      return toSafeConversation(conversation);
    });

    fastify.get("/:id/messages", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const { id } = request.params as { id: string };
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError("Invalid conversation id");
      }
      const parsed = pageQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ValidationError("Invalid message list query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const messages = await conversationService.listMessages(
        tenantId,
        asConversationId(id),
        parsed.data.limit,
        parsed.data.offset,
      );
      return { messages: messages.map(toSafeMessage) };
    });

    fastify.get("/:id/classifications", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const { id } = request.params as { id: string };
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError("Invalid conversation id");
      }
      const parsed = classificationListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ValidationError("Invalid classification list query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const label = parsed.data.label;
      if (label !== undefined && !isClassificationLabel(label)) {
        throw new ValidationError("Invalid classification label filter");
      }
      const classifications = await classificationQuery.listClassifications(
        tenantId,
        asConversationId(id),
        parsed.data.limit,
        parsed.data.offset,
        label !== undefined && isClassificationLabel(label) ? label : undefined,
      );
      return { classifications: classifications.map(toSafeClassification) };
    });

    fastify.get("/:id/facts", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const { id } = request.params as { id: string };
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError("Invalid conversation id");
      }
      const facts = await classificationQuery.getConversationFacts(tenantId, asConversationId(id));
      return { facts: facts ? toSafeFacts(facts) : null };
    });

    fastify.get("/:id/domain-facts", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const { id } = request.params as { id: string };
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError("Invalid conversation id");
      }
      const parsed = domainFactListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ValidationError("Invalid domain fact list query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const label = parsed.data.label;
      if (label !== undefined && !isDomainFactType(label)) {
        throw new ValidationError("Invalid domain fact label filter");
      }
      const facts = await classificationQuery.listDomainFacts(
        tenantId,
        asConversationId(id),
        parsed.data.limit,
        parsed.data.offset,
        label !== undefined && isDomainFactType(label) ? label : undefined,
      );
      return { facts: facts.map(toSafeDomainFact) };
    });

    fastify.get("/:id/policy-signals", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const { id } = request.params as { id: string };
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError("Invalid conversation id");
      }
      const parsed = policySignalListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ValidationError("Invalid policy signal list query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const signal = parsed.data.signal;
      if (signal !== undefined && !isPolicySignalType(signal)) {
        throw new ValidationError("Invalid policy signal filter");
      }
      const signals = await policyQuery.listPolicySignals(
        tenantId,
        asConversationId(id),
        parsed.data.limit,
        parsed.data.offset,
        signal !== undefined && isPolicySignalType(signal) ? signal : undefined,
      );
      return { signals: signals.map(toSafePolicySignal) };
    });

    fastify.get("/:id/messages/:messageId/policy-signals", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const { id, messageId } = request.params as { id: string; messageId: string };
      if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageId)) {
        throw new ValidationError("Invalid conversation or message id");
      }
      const parsed = policySignalListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ValidationError("Invalid policy signal list query", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const signal = parsed.data.signal;
      if (signal !== undefined && !isPolicySignalType(signal)) {
        throw new ValidationError("Invalid policy signal filter");
      }
      const signals = await policyQuery.listMessagePolicySignals(
        tenantId,
        asConversationId(id),
        asMessageId(messageId),
        parsed.data.limit,
        parsed.data.offset,
        signal !== undefined && isPolicySignalType(signal) ? signal : undefined,
      );
      return { signals: signals.map(toSafePolicySignal) };
    });

    fastify.get("/:id/messages/:messageId/classification", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const { id, messageId } = request.params as { id: string; messageId: string };
      if (!UUID_PATTERN.test(id) || !UUID_PATTERN.test(messageId)) {
        throw new ValidationError("Invalid conversation or message id");
      }
      const classification = await classificationQuery.getMessageClassification(
        tenantId,
        asConversationId(id),
        asMessageId(messageId),
      );
      return toSafeClassification(classification);
    });
  };
}
