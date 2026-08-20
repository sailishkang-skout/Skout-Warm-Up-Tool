import type { Database, DatabaseClient } from "../../../shared/db/index.js";
import {
  asConversationId,
  asMessageClassificationId,
  asMessageId,
  asTenantId,
  type ConversationId,
  type MessageClassificationId,
  type MessageId,
  type TenantId,
} from "../../../shared/types/index.js";
import type { ConfidenceBand } from "../domain/classification-confidence.js";
import type {
  ClassificationEvidence,
  ClassificationStatus,
  ClassifierType,
  MessageClassification,
} from "../domain/classification.js";
import { CLASSIFICATION_TAXONOMY_VERSION, type ClassificationLabel } from "../domain/classification-taxonomy.js";
import type { ConversationClassificationFacts } from "../domain/conversation-facts.js";
import type { ConversationDomainFact, DomainFactType } from "../domain/domain-facts.js";
import { isDomainFactType } from "../domain/domain-facts.js";
import type {
  ClassificationRepository,
  CompleteClassificationInput,
  EnqueueClassificationInput,
  InsertDomainFactsInput,
  UpsertConversationFactsInput,
} from "../application/classification-repository.js";

interface ClassificationRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  classifier_version: string;
  taxonomy_version: string;
  classifier_type: ClassifierType | null;
  labels: unknown;
  primary_label: ClassificationLabel | null;
  confidence: string | number | null;
  confidence_band: ConfidenceBand | null;
  reason: string | null;
  evidence: unknown;
  model: string | null;
  input_hash: string | null;
  status: ClassificationStatus;
  attempt_count: number;
  next_attempt_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_error_safe: string | null;
  created_at: Date;
  updated_at: Date;
}

const SELECT_COLUMNS = `
  id, tenant_id, conversation_id, message_id, classifier_version, taxonomy_version, classifier_type,
  labels, primary_label, confidence, confidence_band, reason, evidence, model, input_hash, status,
  attempt_count, next_attempt_at, lease_owner, lease_expires_at, last_error_safe, created_at, updated_at
`;

function mapLabels(value: unknown): ClassificationLabel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is ClassificationLabel => typeof item === "string");
}

function mapEvidence(value: unknown): ClassificationEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const items: ClassificationEvidence[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.ruleId === "string" && typeof record.snippet === "string") {
      items.push({ ruleId: record.ruleId, snippet: record.snippet });
    }
  }
  return items;
}

function mapRow(row: ClassificationRow): MessageClassification {
  const confidence =
    row.confidence === null ? undefined : typeof row.confidence === "number" ? row.confidence : Number(row.confidence);
  return {
    id: asMessageClassificationId(row.id),
    tenantId: asTenantId(row.tenant_id),
    conversationId: asConversationId(row.conversation_id),
    messageId: asMessageId(row.message_id),
    classifierVersion: row.classifier_version,
    taxonomyVersion: row.taxonomy_version || CLASSIFICATION_TAXONOMY_VERSION,
    ...(row.classifier_type ? { classifierType: row.classifier_type } : {}),
    labels: mapLabels(row.labels),
    ...(row.primary_label ? { primaryLabel: row.primary_label } : {}),
    ...(confidence !== undefined && Number.isFinite(confidence) ? { confidence } : {}),
    ...(row.confidence_band ? { confidenceBand: row.confidence_band } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    evidence: mapEvidence(row.evidence),
    ...(row.model ? { model: row.model } : {}),
    ...(row.input_hash ? { inputHash: row.input_hash } : {}),
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.last_error_safe ? { lastErrorSafe: row.last_error_safe } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface FactsRow {
  conversation_id: string;
  tenant_id: string;
  labels: unknown;
  primary_label: string | null;
  needs_human_review: boolean;
  last_classified_message_id: string | null;
  last_classified_at: Date;
  updated_at: Date;
}

function mapFacts(row: FactsRow): ConversationClassificationFacts {
  const labels = mapLabels(row.labels) as ConversationClassificationFacts["labels"];
  return {
    conversationId: asConversationId(row.conversation_id),
    tenantId: asTenantId(row.tenant_id),
    labels,
    ...(row.primary_label ? { primaryLabel: row.primary_label as NonNullable<ConversationClassificationFacts["primaryLabel"]> } : {}),
    needsHumanReview: row.needs_human_review,
    ...(row.last_classified_message_id ? { lastClassifiedMessageId: asMessageId(row.last_classified_message_id) } : {}),
    lastClassifiedAt: row.last_classified_at,
    updatedAt: row.updated_at,
  };
}

interface DomainFactRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  classification_id: string | null;
  fact_type: string;
  classifier_version: string;
  taxonomy_version: string;
  evidence: unknown;
  created_at: Date;
}

function mapDomainFact(row: DomainFactRow): ConversationDomainFact | undefined {
  if (!isDomainFactType(row.fact_type)) {
    return undefined;
  }
  return {
    id: row.id,
    tenantId: asTenantId(row.tenant_id),
    conversationId: asConversationId(row.conversation_id),
    messageId: asMessageId(row.message_id),
    ...(row.classification_id ? { classificationId: asMessageClassificationId(row.classification_id) } : {}),
    factType: row.fact_type,
    classifierVersion: row.classifier_version,
    taxonomyVersion: row.taxonomy_version,
    evidence: mapEvidence(row.evidence),
    createdAt: row.created_at,
  };
}

export class PostgresClassificationRepository implements ClassificationRepository {
  constructor(private readonly db: Database) {}

  async enqueueOnClient(client: DatabaseClient, input: EnqueueClassificationInput): Promise<void> {
    await client.query(
      `INSERT INTO conversation_message_classifications (
         tenant_id, conversation_id, message_id, classifier_version, taxonomy_version, status
       )
       VALUES ($1, $2, $3, $4, $5, 'PENDING')
       ON CONFLICT (tenant_id, message_id, classifier_version, taxonomy_version) DO NOTHING`,
      [input.tenantId, input.conversationId, input.messageId, input.classifierVersion, input.taxonomyVersion],
    );
  }

  async claimNext(leaseOwner: string, leaseDurationMs: number): Promise<MessageClassification | undefined> {
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs);
    const rows = await this.db.query<ClassificationRow>(
      `UPDATE conversation_message_classifications
       SET status = 'PROCESSING', lease_owner = $1, lease_expires_at = $2
       WHERE id = (
         SELECT c.id FROM conversation_message_classifications c
         WHERE (
           (c.status = 'PENDING' AND c.next_attempt_at <= now())
           OR (c.status = 'PROCESSING' AND c.lease_expires_at IS NOT NULL AND c.lease_expires_at < now())
         )
         ORDER BY c.next_attempt_at ASC, c.created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${SELECT_COLUMNS}`,
      [leaseOwner, leaseExpiresAt],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async reclaimExpiredLeases(now: Date, limit: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `UPDATE conversation_message_classifications
       SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL
       WHERE id IN (
         SELECT id FROM conversation_message_classifications
         WHERE status = 'PROCESSING' AND lease_expires_at IS NOT NULL AND lease_expires_at < $1
         ORDER BY lease_expires_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [now, limit],
    );
    return rows.length;
  }

  async completeClassified(
    id: MessageClassificationId,
    leaseOwner: string,
    input: CompleteClassificationInput,
  ): Promise<MessageClassification | undefined> {
    const rows = await this.db.query<ClassificationRow>(
      `UPDATE conversation_message_classifications
       SET status = 'CLASSIFIED',
           labels = $3::jsonb,
           primary_label = $4,
           confidence = $5,
           confidence_band = $6,
           reason = $7,
           model = $8,
           input_hash = $9,
           classifier_type = $10,
           evidence = $11::jsonb,
           last_error_safe = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = $1 AND lease_owner = $2 AND status = 'PROCESSING'
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        leaseOwner,
        JSON.stringify(input.labels),
        input.primaryLabel,
        input.confidence,
        input.confidenceBand,
        input.reason,
        input.model,
        input.inputHash,
        input.classifierType,
        JSON.stringify(input.evidence),
      ],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async completeFailure(
    id: MessageClassificationId,
    leaseOwner: string,
    lastErrorSafe: string,
    next: { status: Extract<ClassificationStatus, "PENDING" | "FAILED">; nextAttemptAt: Date; attemptCount: number },
  ): Promise<void> {
    await this.db.query(
      `UPDATE conversation_message_classifications
       SET status = $3,
           last_error_safe = $4,
           next_attempt_at = $5,
           attempt_count = $6,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = $1 AND lease_owner = $2`,
      [id, leaseOwner, next.status, lastErrorSafe.slice(0, 300), next.nextAttemptAt, next.attemptCount],
    );
  }

  async findByMessage(
    tenantId: TenantId,
    conversationId: ConversationId,
    messageId: MessageId,
    classifierVersion: string,
    taxonomyVersion: string,
  ): Promise<MessageClassification | undefined> {
    const rows = await this.db.query<ClassificationRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversation_message_classifications
       WHERE tenant_id = $1 AND conversation_id = $2 AND message_id = $3
         AND classifier_version = $4 AND taxonomy_version = $5
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenantId, conversationId, messageId, classifierVersion, taxonomyVersion],
    );
    return rows[0] ? mapRow(rows[0]) : undefined;
  }

  async listByConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    label: ClassificationLabel | undefined,
  ): Promise<readonly MessageClassification[]> {
    const rows = await this.db.query<ClassificationRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversation_message_classifications
       WHERE tenant_id = $1 AND conversation_id = $2
         AND ($5::text IS NULL OR labels @> to_jsonb(ARRAY[$5::text]))
       ORDER BY created_at ASC, id ASC
       LIMIT $3 OFFSET $4`,
      [tenantId, conversationId, limit, offset, label ?? null],
    );
    return rows.map(mapRow);
  }

  async listClassifiedByConversation(tenantId: TenantId, conversationId: ConversationId): Promise<readonly MessageClassification[]> {
    const rows = await this.db.query<ClassificationRow>(
      `SELECT ${SELECT_COLUMNS} FROM conversation_message_classifications
       WHERE tenant_id = $1 AND conversation_id = $2 AND status = 'CLASSIFIED'
       ORDER BY created_at ASC`,
      [tenantId, conversationId],
    );
    return rows.map(mapRow);
  }

  async upsertFacts(input: UpsertConversationFactsInput): Promise<{ facts: ConversationClassificationFacts; labelsChanged: boolean }> {
    const existing = await this.getFacts(input.tenantId, input.conversationId);
    const rows = await this.db.query<FactsRow>(
      `INSERT INTO conversation_classification_facts (
         conversation_id, tenant_id, labels, primary_label, needs_human_review,
         last_classified_message_id, last_classified_at
       )
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
       ON CONFLICT (conversation_id) DO UPDATE SET
         labels = EXCLUDED.labels,
         primary_label = EXCLUDED.primary_label,
         needs_human_review = EXCLUDED.needs_human_review,
         last_classified_message_id = EXCLUDED.last_classified_message_id,
         last_classified_at = EXCLUDED.last_classified_at
       RETURNING conversation_id, tenant_id, labels, primary_label, needs_human_review,
                 last_classified_message_id, last_classified_at, updated_at`,
      [
        input.conversationId,
        input.tenantId,
        JSON.stringify(input.labels),
        input.primaryLabel ?? null,
        input.needsHumanReview,
        input.lastClassifiedMessageId,
        input.lastClassifiedAt,
      ],
    );
    const facts = mapFacts(rows[0]!);
    const previous = JSON.stringify(existing?.labels ?? []);
    const next = JSON.stringify(facts.labels);
    return { facts, labelsChanged: previous !== next };
  }

  async getFacts(tenantId: TenantId, conversationId: ConversationId): Promise<ConversationClassificationFacts | undefined> {
    const rows = await this.db.query<FactsRow>(
      `SELECT conversation_id, tenant_id, labels, primary_label, needs_human_review,
              last_classified_message_id, last_classified_at, updated_at
       FROM conversation_classification_facts
       WHERE tenant_id = $1 AND conversation_id = $2`,
      [tenantId, conversationId],
    );
    return rows[0] ? mapFacts(rows[0]) : undefined;
  }

  async insertDomainFacts(input: InsertDomainFactsInput): Promise<readonly ConversationDomainFact[]> {
    const inserted: ConversationDomainFact[] = [];
    for (const factType of input.factTypes) {
      const rows = await this.db.query<DomainFactRow>(
        `INSERT INTO conversation_domain_facts (
           tenant_id, conversation_id, message_id, classification_id, fact_type,
           classifier_version, taxonomy_version, evidence
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, message_id, fact_type, classifier_version, taxonomy_version) DO NOTHING
         RETURNING id, tenant_id, conversation_id, message_id, classification_id, fact_type,
                   classifier_version, taxonomy_version, evidence, created_at`,
        [
          input.tenantId,
          input.conversationId,
          input.messageId,
          input.classificationId,
          factType,
          input.classifierVersion,
          input.taxonomyVersion,
          JSON.stringify(input.evidence),
        ],
      );
      const mapped = rows[0] ? mapDomainFact(rows[0]) : undefined;
      if (mapped) {
        inserted.push(mapped);
      }
    }
    return inserted;
  }

  async listDomainFacts(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    factType: DomainFactType | undefined,
  ): Promise<readonly ConversationDomainFact[]> {
    const rows = await this.db.query<DomainFactRow>(
      `SELECT id, tenant_id, conversation_id, message_id, classification_id, fact_type,
              classifier_version, taxonomy_version, evidence, created_at
       FROM conversation_domain_facts
       WHERE tenant_id = $1 AND conversation_id = $2
         AND ($5::text IS NULL OR fact_type = $5)
       ORDER BY created_at ASC, id ASC
       LIMIT $3 OFFSET $4`,
      [tenantId, conversationId, limit, offset, factType ?? null],
    );
    return rows.flatMap((row) => {
      const mapped = mapDomainFact(row);
      return mapped ? [mapped] : [];
    });
  }
}
