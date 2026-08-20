/**
 * Network-level routing advice. This never replaces risk, eligibility,
 * capacity, or the safety gate. The router may shrink or skip the candidate
 * set; it must not authorize a send.
 */
export const NETWORK_POLICY_DECISIONS = [
  "ALLOW",
  "DEFER",
  "REDUCE",
  "TEMPORARY_BLOCK",
  "PERMANENT_BLOCK",
] as const;
export type NetworkPolicyDecision = (typeof NETWORK_POLICY_DECISIONS)[number];

export interface NetworkHealthEvidence {
  readonly mailboxes: number;
  readonly activeMailboxes: number;
  readonly degradedMailboxes: number;
  readonly quarantinedMailboxes: number;
  readonly credentialUnavailable: number;
  readonly remainingMailboxCapacityToday: number;
  readonly activeNetworks: number;
}

export interface NetworkPolicyResult {
  readonly decision: NetworkPolicyDecision;
  readonly reason: string;
}

export function evaluateNetworkPolicy(evidence: NetworkHealthEvidence): NetworkPolicyResult {
  if (evidence.mailboxes === 0) {
    return { decision: "ALLOW", reason: "NO_CANDIDATES" };
  }
  if (evidence.remainingMailboxCapacityToday <= 0) {
    return { decision: "DEFER", reason: "NETWORK_CAPACITY_EXHAUSTED" };
  }
  const unhealthy = evidence.degradedMailboxes + evidence.quarantinedMailboxes + evidence.credentialUnavailable;
  if (unhealthy * 2 >= evidence.mailboxes) {
    return { decision: "REDUCE", reason: "NETWORK_UNHEALTHY" };
  }
  return { decision: "ALLOW", reason: "NETWORK_HEALTHY" };
}
