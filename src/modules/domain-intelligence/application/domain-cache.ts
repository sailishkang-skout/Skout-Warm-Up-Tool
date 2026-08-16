import type { DomainAuthenticationAssessment } from "../domain/domain-authentication.js";

/**
 * The fast-path read cache in front of the durable `domain_intelligence`
 * table (see application/domain-intelligence-repository.ts) — narrows what
 * domain logic can do with Redis to exactly this, per Stage 7 spec section
 * 16 ("do not directly depend on Redis from domain logic; use the shared
 * Redis abstraction if needed"). `infrastructure/redis-domain-cache.ts` is
 * the production implementation.
 */
export interface DomainCache {
  get(domain: string): Promise<DomainAuthenticationAssessment | undefined>;
  set(domain: string, assessment: DomainAuthenticationAssessment, ttlSeconds: number): Promise<void>;
}
