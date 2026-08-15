declare const brand: unique symbol;

/**
 * Nominal typing helper: two `Branded<string, "A">` / `Branded<string, "B">`
 * types are structurally identical to `string` but not to each other, so a
 * `MailboxId` can never be passed where a `TenantId` is expected by accident.
 */
export type Branded<Value, Tag extends string> = Value & { readonly [brand]: Tag };

export type TenantId = Branded<string, "TenantId">;
export type UserId = Branded<string, "UserId">;
export type MailboxId = Branded<string, "MailboxId">;
export type ProviderAccountId = Branded<string, "ProviderAccountId">;
export type WarmupProfileId = Branded<string, "WarmupProfileId">;
export type WarmupJobId = Branded<string, "WarmupJobId">;
export type ConversationId = Branded<string, "ConversationId">;
export type MessageId = Branded<string, "MessageId">;
export type DeliveryEventId = Branded<string, "DeliveryEventId">;
export type HealthSnapshotId = Branded<string, "HealthSnapshotId">;
export type RiskEventId = Branded<string, "RiskEventId">;
export type PolicyDecisionId = Branded<string, "PolicyDecisionId">;
export type AuditEventId = Branded<string, "AuditEventId">;
export type RequestId = Branded<string, "RequestId">;
export type CorrelationId = Branded<string, "CorrelationId">;

function brander<Tag extends string>(): (value: string) => Branded<string, Tag> {
  return (value: string) => value as Branded<string, Tag>;
}

export const asTenantId = brander<"TenantId">();
export const asUserId = brander<"UserId">();
export const asMailboxId = brander<"MailboxId">();
export const asProviderAccountId = brander<"ProviderAccountId">();
export const asWarmupProfileId = brander<"WarmupProfileId">();
export const asWarmupJobId = brander<"WarmupJobId">();
export const asConversationId = brander<"ConversationId">();
export const asMessageId = brander<"MessageId">();
export const asDeliveryEventId = brander<"DeliveryEventId">();
export const asHealthSnapshotId = brander<"HealthSnapshotId">();
export const asRiskEventId = brander<"RiskEventId">();
export const asPolicyDecisionId = brander<"PolicyDecisionId">();
export const asAuditEventId = brander<"AuditEventId">();
export const asRequestId = brander<"RequestId">();
export const asCorrelationId = brander<"CorrelationId">();
