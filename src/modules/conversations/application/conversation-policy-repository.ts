import type { ConversationId, ConversationPolicyEvaluationId, MessageId, TenantId } from "../../../shared/types/index.js";
import type { DomainFactType } from "../domain/domain-facts.js";
import type { ConversationPolicyEvaluation, ConversationPolicySignal } from "../domain/policy-result.js";
import type { PolicySignalDraft } from "../domain/policy-evaluation.js";
import type { PolicySignalType } from "../domain/policy-signal-taxonomy.js";

export interface CompletePolicyEvaluationInput {
  readonly signals: readonly PolicySignalDraft[];
  readonly sourceFactIds: Readonly<Partial<Record<DomainFactType, string>>>;
}

export interface ConversationPolicyRepository {
  enqueuePendingFromFacts(policyVersion: string, taxonomyVersion: string): Promise<number>;
  claimNext(leaseOwner: string, leaseDurationMs: number): Promise<ConversationPolicyEvaluation | undefined>;
  reclaimExpiredLeases(now: Date, limit: number): Promise<number>;
  completeEvaluated(
    id: ConversationPolicyEvaluationId,
    leaseOwner: string,
    input: CompletePolicyEvaluationInput,
  ): Promise<readonly ConversationPolicySignal[] | undefined>;
  completeFailure(
    id: ConversationPolicyEvaluationId,
    leaseOwner: string,
    lastErrorSafe: string,
    next: { status: "PENDING" | "FAILED"; nextAttemptAt: Date; attemptCount: number },
  ): Promise<void>;
  listSignalsByConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
    limit: number,
    offset: number,
    signal: PolicySignalType | undefined,
  ): Promise<readonly ConversationPolicySignal[]>;
  listSignalsByMessage(
    tenantId: TenantId,
    conversationId: ConversationId,
    messageId: MessageId,
    limit: number,
    offset: number,
    signal: PolicySignalType | undefined,
  ): Promise<readonly ConversationPolicySignal[]>;
  listEvaluationsByConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
  ): Promise<readonly ConversationPolicyEvaluation[]>;
  listDomainFactsForMessage(
    tenantId: TenantId,
    messageId: MessageId,
  ): Promise<readonly { id: string; factType: DomainFactType }[]>;
  messageBelongsToConversation(
    tenantId: TenantId,
    conversationId: ConversationId,
    messageId: MessageId,
  ): Promise<boolean>;
}
