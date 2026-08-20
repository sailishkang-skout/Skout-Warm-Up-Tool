/**
 * Process-local counters. Names follow OpenTelemetry-style dotted metrics.
 * Values are counts/latencies only — never message bodies or credentials.
 */
export type MetricAttributes = Readonly<Record<string, string | number | boolean>>;

export interface MetricSnapshot {
  readonly name: string;
  readonly value: number;
}

const counters = new Map<string, number>();
const gauges = new Map<string, number>();

export function incrementCounter(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function readCounter(name: string): number {
  return counters.get(name) ?? 0;
}

export function setGauge(name: string, value: number): void {
  gauges.set(name, value);
}

export function readGauge(name: string): number {
  return gauges.get(name) ?? 0;
}

export function snapshotCounters(): readonly MetricSnapshot[] {
  return [...counters.entries()].map(([name, value]) => ({ name, value }));
}

export function resetCountersForTests(): void {
  counters.clear();
  gauges.clear();
}

export const METRIC = {
  warmupTick: "warmup.worker.tick",
  warmupTickFailure: "warmup.worker.tick.failure",
  inboundTick: "inbound.worker.tick",
  inboundTickFailure: "inbound.worker.tick.failure",
  classificationTick: "classification.worker.tick",
  classificationTickFailure: "classification.worker.tick.failure",
  policyTick: "policy.worker.tick",
  policyTickFailure: "policy.worker.tick.failure",
  integrationEventsRead: "integration.events.read",
  leaseReclaimed: "worker.lease.reclaimed",
  warmupPoolSelection: "warmup.pool.selection",
  warmupPoolSelectionFailed: "warmup.pool.selection_failed",
  warmupPoolRotation: "warmup.pool.rotation",
  warmupPoolNoEligibleMailbox: "warmup.pool.no_eligible_mailbox",
  warmupPoolDomainSkipped: "warmup.pool.domain_skipped",
  warmupPoolHealthSkipped: "warmup.pool.health_skipped",
  warmupNetworkRouteAttempt: "warmup_network.route.attempt",
  warmupNetworkRouteSuccess: "warmup_network.route.success",
  warmupNetworkRouteNoEligible: "warmup_network.route.no_eligible",
  warmupNetworkRouteFailure: "warmup_network.route.failure",
  warmupNetworkRouteAuthFailed: "warmup_network.route.auth_failed",
  warmupNetworkRouteCapacityExhausted: "warmup_network.route.capacity_exhausted",
  warmupNetworkRouteQuarantined: "warmup_network.route.quarantined",
  warmupNetworkRouteProviderMismatch: "warmup_network.route.provider_mismatch",
  warmupNetworkCapacityRemaining: "warmup_network.capacity.remaining",
  warmupNetworkMailboxSelected: "warmup_network.mailbox.selected",
  warmupNetworkDomainSelected: "warmup_network.domain.selected",
  killSwitchActivated: "operations.kill_switch.activated",
  killSwitchDeactivated: "operations.kill_switch.deactivated",
  quarantineActivated: "operations.quarantine.activated",
  mailboxOperationalTransition: "mailbox.operational.transition",
  directoryApiCall: "provider.directory.api_call",
  directoryApiFailure: "provider.directory.api_failure",
  mailboxProvisionAttempt: "provider_provision_attempt",
  mailboxProvisionSuccess: "provider_provision_success",
  mailboxProvisionFailure: "provider_provision_failure",
} as const;
