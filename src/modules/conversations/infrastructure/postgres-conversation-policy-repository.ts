import type { Database, DatabaseClient } from "../../../shared/db/index.js";
import { mapPolicySignalToIntegrationEvent } from "../domain/integration-event-mapping.js";
import { insertIntegrationEvent } from "./postgres-integration-event-repository.js";
import {
  asConversationId,
  asConversationPolicyEvaluationId,
  asConversationPolicySignalId,
  asMailboxId,
  asMessageId,
  asTenantId,
  asWarmupExecutionIntentId,
  type ConversationId,
  type ConversationPolicyEvaluationId,
  type MessageId,
  type TenantId,
} from "../../../shared/types/index.js";
import type { DomainFactType } from "../domain/domain-facts.js";
import { isDomainFactType } from "../domain/domain-facts.js";
import { computeFactSetHash } from "../domain/policy-evaluation.js";
import type { ConversationPolicyEvaluation, ConversationPolicySignal, PolicyEvaluationStatus } from "../domain/policy-result.js";
import type { PolicySignalPriority, PolicySignalType } from "../domain/policy-signal-taxonomy.js";
import { isPolicySignalType } from "../domain/policy-signal-taxonomy.js";
import type {
  CompletePolicyEvaluationInput,
  ConversationPolicyRepository,
} from "../application/conversation-policy-repository.js";

interface EvaluationRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  source_message_id: string | null;
  policy_version: string;
  taxonomy_version: string;
  fact_set_hash: string;
  fact_types: unknown;
  status: PolicyEvaluationStatus;
  attempt_count: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_safe: string | null;
  created_at: Date;
  evaluated_at: Date | null;
}

interface SignalRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  policy_evaluation_id: string;
  source_message_id: string | null;
  signal: string;
  priority: PolicySignalPriority;
  source_fact_type: string | null;
  source_fact_id: string | null;
  policy_version: string;
  created_at: Date;
}

const EVAL_COLUMNS = `
  id, tenant_id, conversation_id, source_message_id, policy_version, taxonomy_version,
  fact_set_hash, fact_types, status, attempt_count, next_attempt_at, lease_owner,
  lease_expires_at, last_error_safe, created_at, evaluated_at
`;

function mapFactTypes(value: unknown): DomainFactType[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is DomainFactType => typeof item === "string" && isDomainFactType(item));
}

function mapEvaluation(row: EvaluationRow): ConversationPolicyEvaluation {
  return {
    id: asConversationPolicyEvaluationId(row.id),
    tenantId: asTenantId(row.tenant_id),
    conversationId: asConversationId(row.conversation_id),
    ...(row.source_message_id ? { sourceMessageId: asMessageId(row.source_message_id) } : {}),
    policyVersion: row.policy_version,
    taxonomyVersion: row.taxonomy_version,
    factSetHash: row.fact_set_hash,
    factTypes: mapFactTypes(row.fact_types),
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_error_safe ? { lastErrorSafe: row.last_error_safe } : {}),
    createdAt: row.created_at,
    ...(row.evaluated_at ? { evaluatedAt: row.evaluated_at } : {}),
  };
}

function mapSignal(row: SignalRow): ConversationPolicySignal | undefined {
  if (!isPolicySignalType(row.signal)) {
    return undefined;
  }
  return {
    id: asConversationPolicySignalId(row.id),
    tenantId: asTenantId(row.tenant_id),
    conversationId: asConversationId(row.conversation_id),
    policyEvaluationId: asConversationPolicyEvaluationId(row.policy_evaluation_id),
    ...(row.source_message_id ? { sourceMessageId: asMessageId(row.source_message_id) } : {}),
    signal: row.signal,
    priority: row.priority,
    ...(row.source_fact_type && isDomainFactType(row.source_fact_type) ? { sourceFactType: row.source_fact_type } : {}),
    ...(row.source_fact_id ? { sourceFactId: row.source_fact_id } : {}),
    policyVersion: row.policy_version,
    createdAt: row.created_at,
  };
}

export class PostgresConversationPolicyRepository implements ConversationPolicyRepository {
  constructor(private readonly db: Database) {}

  async enqueuePendingFromFacts(policyVersion: string, taxonomyVersion: string): Promise<number> {
    const groups = await this.db.query<{
      tenant_id: string;
      conversation_id: string;
      message_id: string;
      fact_types: unknown;
    }>(
      `SELECT g.tenant_id, g.conversation_id, g.message_id, g.fact_types
       FROM (
         SELECT tenant_id, conversation_id, message_id,
                jsonb_agg(fact_type ORDER BY fact_type) AS fact_types
         FROM (
           SELECT DISTINCT tenant_id, conversation_id, message_id, fact_type
           FROM conversation_domain_facts
         ) distinct_facts
         GROUP BY tenant_id, conversation_id, message_id
       ) g
       WHERE NOT EXISTS (
         SELECT 1
         FROM conversation_policy_evaluations e
         WHERE e.tenant_id = g.tenant_id
           AND e.source_message_id = g.message_id
           AND e.policy_version = $1
           AND e.fact_types = g.fact_types
       )
       ORDER BY g.message_id ASC
       LIMIT 100`,
      [policyVersion],
    );

    let inserted = 0;
    for (const group of groups) {
      const factTypes = mapFactTypes(group.fact_types);
      const factSetHash = computeFactSetHash(factTypes);
      const rows = await this.db.query<{ id: string }>(
        `INSERT INTO conversation_policy_evaluations (
           tenant_id, conversation_id, source_message_id, policy_version, taxonomy_version,
           fact_set_hash, fact_types, status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'PENDING')
         ON CONFLICT (tenant_id, source_message_id, policy_version, fact_set_hash) DO NOTHING
         RETURNING id`,
        [
          group.tenant_id,
          group.conversation_id,
          group.message_id,
          policyVersion,
          taxonomyVersion,
          factSetHash,
          JSON.stringify(factTypes),
        ],
      );
      if (rows[0]) {
        inserted += 1;
      }
    }
    return inserted;
  }

  async claimNext(leaseOwner: string, leaseDurationMs: number): Promise<ConversationPolicyEvaluation | undefined> {
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    const rows = await this.db.query<EvaluationRow>(
      `UPDATE conversation_policy_evaluations
       SET status = 'EVALUATING', lease_owner = $1, lease_expires_at = $2
       WHERE id = (
         SELECT e.id FROM conversation_policy_evaluations e
         WHERE (
           (e.status = 'PENDING' AND e.next_attempt_at <= now())
           OR (e.status = 'EVALUATING' AND e.lease_expires_at IS NOT NULL AND e.lease_expires_at < now())
         )
         ORDER BY e.next_attempt_at ASC, e.created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${EVAL_COLUMNS}`,
      [leaseOwner, leaseExpiresAt],
    );
    return rows[0] ? mapEvaluation(rows[0]) : undefined;
  }

  async reclaimExpiredLeases(now: Date, limit: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE conversation_policy_evaluations
       SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL
       WHERE id IN (
         SELECT id FROM conversation_policy_evaluations
         WHERE status = 'EVALUATING' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1
         ORDER BY lease_expires_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [now, limit],
    );
    return rows.length;
  }

  async completeEvaluated(
    id: ConversationPolicyEvaluationId,
    leaseOwner: string,
    input: CompletePolicyEvaluationInput,
  ): Promise<readonly ConversationPolicySignal[] | undefined> {
    return this.db.withTransaction((tx) => this.completeEvaluatedInTx(tx, id, leaseOwner, input));
  }

  private async completeEvaluatedInTx(
    tx: DatabaseClient,
    id: ConversationPolicyEvaluationId,
    leaseOwner: string,
    input: CompletePolicyEvaluationInput,
  ): Promise<readonly ConversationPolicySignal[] | undefined> {
    const evaluationRows = await tx.query<EvaluationRow>(
      `UPDATE conversation_policy_evaluations
       SET status = 'EVALUATED',
           lease_owner = NULL,
           lease_expires_at = NULL,
           evaluated_at = now(),
           last_error_safe = NULL
       WHERE id = $1 AND lease_owner = $2 AND status = 'EVALUATING'
       RETURNING ${EVAL_COLUMNS}`,
      [id, leaseOwner],
    );
    const evaluation = evaluationRows[0];
    if (!evaluation) {
      return undefined;
    }

    const correlation: {
      contactIdentifier?: string;
      mailboxId?: string;
      executionIntentId?: string;
    } = evaluation.source_message_id
      ? await lookupMessageCorrelation(tx, evaluation.tenant_id, evaluation.source_message_id)
      : await lookupConversationMailbox(tx, evaluation.tenant_id, evaluation.conversation_id);

    const created: ConversationPolicySignal[] = [];
    for (const draft of input.signals) {
      const sourceFactId = input.sourceFactIds[draft.sourceFactType];
      const rows = await tx.query<SignalRow>(
        `INSERT INTO conversation_policy_signals (
           tenant_id, conversation_id, policy_evaluation_id, source_message_id,
           signal, priority, source_fact_type, source_fact_id, policy_version
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (policy_evaluation_id, signal) DO NOTHING
         RETURNING id, tenant_id, conversation_id, policy_evaluation_id, source_message_id,
                   signal, priority, source_fact_type, source_fact_id, policy_version, created_at`,
        [
          evaluation.tenant_id,
          evaluation.conversation_id,
          evaluation.id,
          evaluation.source_message_id,
          draft.signal,
          draft.priority,
          draft.sourceFactType,
          sourceFactId ?? null,
          evaluation.policy_version,
        ],
      );
      const mapped = rows[0] ? mapSignal(rows[0]) : undefined;
      if (!mapped) {
        continue;
      }
      created.push(mapped);
      const integrationEvent = mapPolicySignalToIntegrationEvent({
        tenantId: mapped.tenantId,
        conversationId: mapped.conversationId,
        ...(mapped.sourceMessageId ? { messageId: mapped.sourceMessageId } : {}),
        ...(correlation.mailboxId ? { mailboxId: asMailboxId(correlation.mailboxId) } : {}),
        ...(correlation.executionIntentId
          ? { executionIntentId: asWarmupExecutionIntentId(correlation.executionIntentId) }
          : {}),
        policySignalId: mapped.id,
        signal: mapped.signal,
        priority: mapped.priority,
        ...(mapped.sourceFactType ? { sourceFactType: mapped.sourceFactType } : {}),
        ...(mapped.sourceFactId ? { sourceFactId: mapped.sourceFactId } : {}),
        policyVersion: mapped.policyVersion,
        occurredAt: mapped.createdAt,
        ...(correlation.contactIdentifier ? { contactIdentifier: correlation.contactIdentifier } : {}),
      });
      if (integrationEvent) {
        await insertIntegrationEvent(tx, integrationEvent);
      }
    }
    return created;
  }

  async completeFailure(
    id: ConversationPolicyEvaluationId,
    leaseOwner: string,
    lastErrorSafe: string,
    next: { status: "PENDING" | "FAILED"; nextAttemptAt: Date; attemptCount: number },
  ): Promise<void> {
    await this.db.query(
      `UPDATE conversation_policy_evaluations
       SET status = $3,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error_safe = $4,
           next_attempt_at = $5,
           attempt_count = $6
       WHERE id = $1 AND lease_owner = $2 AND status = 'EVALUATING'`,
      [id, leaseOwner, next.status, lastErrorSafe.slice(0, 300), next.nextAttemptAt, next.attemptCount],
    );
  }

  async listSignalsByConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    signal: PolicySignalType | undefined,
  ): Promise<readonly ConversationPolicySignal[]> {
    const rows = await this.db.query<SignalRow>(
      `SELECT id, tenant_id, conversation_id, policy_evaluation_id, source_message_id,
              signal, priority, source_fact_type, source_fact_id, policy_version, created_at
       FROM conversation_policy_signals
       WHERE tenant_id = $1 AND conversation_id = $2
         AND ($5::text IS NULL OR signal = $5)
       ORDER BY
         CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END ASC,
         created_at ASC,
         id ASC
       LIMIT $3 OFFSET $4`,
      [tenantId, conversationId, limit, offset, signal ?? null],
    );
    return rows.flatMap((row) => {
      const mapped = mapSignal(row);
      return mapped ? [mapped] : [];
    });
  }

  async listSignalsByMessage(
    tenantId: TenantId,
    conversationId: ConversationId,
    messageId: MessageId,
    limit: number,
    offset: number,
    signal: PolicySignalType | undefined,
  ): Promise<readonly ConversationPolicySignal[]> {
    const rows = await this.db.query<SignalRow>(
      `SELECT id, tenant_id, conversation_id, policy_evaluation_id, source_message_id,
              signal, priority, source_fact_type, source_fact_id, policy_version, created_at
       FROM conversation_policy_signals
       WHERE tenant_id = $1 AND conversation_id = $2 AND source_message_id = $3
         AND ($6::text IS NULL OR signal = $6)
       ORDER BY
         CASE priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END ASC,
         created_at ASC,
         id ASC
       LIMIT $4 OFFSET $5`,
      [tenantId, conversationId, messageId, limit, offset, signal ?? null],
    );
    return rows.flatMap((row) => {
      const mapped = mapSignal(row);
      return mapped ? [mapped] : [];
    });
  }

  async listEvaluationsByConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
  ): Promise<readonly ConversationPolicyEvaluation[]> {
    const rows = await this.db.query<EvaluationRow>(
      `SELECT ${EVAL_COLUMNS}
       FROM conversation_policy_evaluations
       WHERE tenant_id = $1 AND conversation_id = $2
       ORDER BY created_at ASC, id ASC`,
      [tenantId, conversationId],
    );
    return rows.map(mapEvaluation);
  }

  async listDomainFactsForMessage(
    tenantId: TenantId,
    messageId: MessageId,
  ): Promise<readonly { id: string; factType: DomainFactType }[]> {
    const rows = await this.db.query<{ id: string; fact_type: string }>(
      `SELECT id, fact_type
       FROM conversation_domain_facts
       WHERE tenant_id = $1 AND message_id = $2
       ORDER BY created_at ASC, id ASC`,
      [tenantId, messageId],
    );
    return rows.flatMap((row) =>
      isDomainFactType(row.fact_type) ? [{ id: row.id, factType: row.fact_type }] : [],
    );
  }

  async messageBelongsToConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
    messageId: MessageId,
  ): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `SELECT id FROM conversation_messages
       WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3
       LIMIT 1`,
      [tenantId, conversationId, messageId],
    );
    return rows.length > 0;
  }
}

async function lookupMessageCorrelation(
  client: DatabaseClient,
  tenantId: string,
  messageId: string,
): Promise<{
  contactIdentifier?: string;
  mailboxId?: string;
  executionIntentId?: string;
}> {
  const rows = await client.query<{
    sender: string;
    recipients: unknown;
    direction: string;
    mailbox_id: string;
    execution_intent_id: string | null;
  }>(
    `SELECT sender, recipients, direction, mailbox_id, execution_intent_id
     FROM conversation_messages
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenantId, messageId],
  );
  const row = rows[0];
  if (!row) {
    return {};
  }
  let contactIdentifier: string | undefined;
  if (row.direction === "INBOUND") {
    contactIdentifier = row.sender;
  } else {
    const recipients = Array.isArray(row.recipients) ? row.recipients : [];
    const firstRecipient = recipients.find((item): item is string => typeof item === "string");
    contactIdentifier = firstRecipient;
  }
  return {
    ...(contactIdentifier ? { contactIdentifier } : {}),
    mailboxId: row.mailbox_id,
    ...(row.execution_intent_id ? { executionIntentId: row.execution_intent_id } : {}),
  };
}

async function lookupConversationMailbox(
  client: DatabaseClient,
  tenantId: string,
  conversationId: string,
): Promise<{ mailboxId?: string }> {
  const rows = await client.query<{ mailbox_id: string }>(
    `SELECT mailbox_id FROM conversations WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, conversationId],
  );
  return rows[0] ? { mailboxId: rows[0].mailbox_id } : {};
}
