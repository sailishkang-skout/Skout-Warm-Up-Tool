/**
 * `UNHEALTHY` rather than a Stage-6-style `UNAVAILABLE`/`UNAUTHENTICATED`
 * split — this is a coarser, decision-facing status (feeding risk/
 * eligibility policy), not a diagnostic one; the finer-grained provider
 * health status is preserved separately in the underlying signals for
 * anyone who needs it. `UNKNOWN` is distinct from `UNHEALTHY`: it means
 * "not yet measured," never a guess in either direction.
 */
export const HEALTH_STATUSES = ["HEALTHY", "DEGRADED", "UNHEALTHY", "UNKNOWN"] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/**
 * Component-level, not one collapsed score (Stage 7 spec section 8:
 * "Do not collapse everything into one score immediately. Maintain
 * component-level assessments."). `RiskAssessment` (`risk` module) is a
 * separate, downstream model that consumes this one — health describes
 * "what is true right now," risk describes "how concerning is that."
 */
export interface MailboxHealthAssessment {
  readonly connection: HealthStatus;
  readonly authentication: HealthStatus;
  readonly sending: HealthStatus;
  readonly receiving: HealthStatus;
  readonly domain: HealthStatus;
  readonly configuration: HealthStatus;
  readonly assessedAt: Date;
}
