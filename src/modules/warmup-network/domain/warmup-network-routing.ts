import type { MailboxId, TenantId, WarmupNetworkDomainId, WarmupNetworkMailboxId, WarmupNetworkRoutingDecisionId } from "../../../shared/types/index.js";

export const WARMUP_NETWORK_ROUTING_OUTCOMES = [
  "SELECTED",
  "CUSTOMER_MAILBOX_DISCONNECTED",
  "NO_ELIGIBLE_WARMUP_MAILBOX",
] as const;
export type WarmupNetworkRoutingOutcome = (typeof WARMUP_NETWORK_ROUTING_OUTCOMES)[number];

export const WARMUP_NETWORK_FAILURE_CLASSES = ["TEMPORARY", "PERMANENT"] as const;
export type WarmupNetworkFailureClass = (typeof WARMUP_NETWORK_FAILURE_CLASSES)[number];

export interface WarmupNetworkRoutingDecision {
  readonly id: WarmupNetworkRoutingDecisionId;
  readonly routingRequestKey: string;
  readonly customerTenantId: TenantId;
  readonly customerMailboxId: MailboxId;
  readonly selectedNetworkMailboxId?: WarmupNetworkMailboxId;
  readonly selectedDomainId?: WarmupNetworkDomainId;
  readonly outcome: WarmupNetworkRoutingOutcome;
  readonly reason: string;
  readonly eligibilitySummary: Record<string, unknown>;
  readonly createdAt: Date;
}

export interface WarmupNetworkSelection {
  readonly networkMailboxId: WarmupNetworkMailboxId;
  readonly domainId: WarmupNetworkDomainId;
  readonly mailboxId: MailboxId;
  readonly mailboxAddress: string;
  readonly provider: "GMAIL" | "MICROSOFT365";
}

export interface WarmupNetworkRouteResult {
  readonly decision: WarmupNetworkRoutingDecision;
  readonly selected?: WarmupNetworkSelection;
  readonly failureClass?: WarmupNetworkFailureClass;
}
