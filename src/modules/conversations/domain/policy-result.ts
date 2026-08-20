import type {
  ConversationId,
  ConversationPolicyEvaluationId,
  ConversationPolicySignalId,
  MessageId,
  TenantId,
} from "../../../shared/types/index.js";
import type { DomainFactType } from "./domain-facts.js";
import type { PolicySignalPriority, PolicySignalType } from "./policy-signal-taxonomy.js";

export const POLICY_EVALUATION_STATUSES = ["PENDING", "EVALUATING", "EVALUATED", "FAILED"] as const;
export type PolicyEvaluationStatus = (typeof POLICY_EVALUATION_STATUSES)[number];

export interface ConversationPolicyEvaluation {
  readonly id: ConversationPolicyEvaluationId;
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly sourceMessageId?: MessageId;
  readonly policyVersion: string;
  readonly taxonomyVersion: string;
  readonly factSetHash: string;
  readonly factTypes: readonly DomainFactType[];
  readonly status: PolicyEvaluationStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt: Date;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: Date;
  readonly lastErrorSafe?: string;
  readonly createdAt: Date;
  readonly evaluatedAt?: Date;
}

export interface ConversationPolicySignal {
  readonly id: ConversationPolicySignalId;
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly policyEvaluationId: ConversationPolicyEvaluationId;
  readonly sourceMessageId?: MessageId;
  readonly signal: PolicySignalType;
  readonly priority: PolicySignalPriority;
  readonly sourceFactType?: DomainFactType;
  readonly sourceFactId?: string;
  readonly policyVersion: string;
  readonly createdAt: Date;
}
