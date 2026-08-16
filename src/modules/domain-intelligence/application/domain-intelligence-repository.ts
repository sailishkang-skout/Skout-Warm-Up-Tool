import type { DomainAuthenticationAssessment } from "../domain/domain-authentication.js";

/**
 * The durable store behind `DomainIntelligenceService` — one row per
 * domain, replaced (not appended) on each refresh; see
 * migrations/009_create_domain_intelligence.sql for why this table has no
 * history of its own. Port implemented by
 * `infrastructure/postgres-domain-intelligence-repository.ts`.
 */
export interface DomainIntelligenceRepository {
  findByDomain(domain: string): Promise<DomainAuthenticationAssessment | undefined>;
  upsert(assessment: DomainAuthenticationAssessment): Promise<void>;
}
