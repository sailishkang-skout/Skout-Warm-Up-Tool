import type { DomainAuthenticationAssessment } from "../domain/domain-authentication.js";
import type { DomainCache } from "./domain-cache.js";
import type { DomainIntelligenceRepository } from "./domain-intelligence-repository.js";
import type { DnsResolver } from "./dns-resolver.js";

export interface GetDomainAssessmentOptions {
  readonly forceRefresh?: boolean;
}

export interface DomainIntelligenceService {
  getAssessment(domain: string, options?: GetDomainAssessmentOptions): Promise<DomainAuthenticationAssessment>;
}

export interface CreateDomainIntelligenceServiceDeps {
  readonly cache: DomainCache;
  readonly repository: DomainIntelligenceRepository;
  readonly resolver: DnsResolver;
}

// DNS records change rarely and re-checking every domain on every mailbox
// request would be exactly the "query external infrastructure on every
// mailbox request" Stage 7 spec section 16 forbids. A day is long enough
// that this service never becomes a meaningful source of outbound DNS
// traffic, short enough that a real SPF/DMARC fix a customer makes shows up
// without them needing to know a manual refresh exists.
const DOMAIN_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
// The Redis fast-path cache TTL is shorter than the refresh interval on
// purpose: it just saves a Postgres round trip for repeated lookups within
// the same window, it does not by itself decide when DNS gets re-queried —
// `DOMAIN_REFRESH_INTERVAL_MS` (checked against the Postgres row's
// `checkedAt`) is the actual staleness policy.
const DOMAIN_CACHE_TTL_SECONDS = 3600;

/**
 * Orchestrates the read path Stage 7 spec section 16 asks for:
 * `DomainCache` (fast) -> `DomainIntelligenceRepository` (durable) -> real
 * DNS via `DnsResolver`, falling through only as far as each layer's data
 * is missing or stale. Every DNS failure the resolver surfaces already
 * arrives as a typed `DnsCheckStatus`, never a thrown error — this service
 * has nothing to catch.
 */
export function createDomainIntelligenceService(deps: CreateDomainIntelligenceServiceDeps): DomainIntelligenceService {
  const { cache, repository, resolver } = deps;

  return {
    async getAssessment(
      domain: string,
      options: GetDomainAssessmentOptions = {},
    ): Promise<DomainAuthenticationAssessment> {
      const normalizedDomain = domain.trim().toLowerCase();

      if (!options.forceRefresh) {
        const cached = await cache.get(normalizedDomain);
        if (cached) {
          return cached;
        }

        const stored = await repository.findByDomain(normalizedDomain);
        if (stored && Date.now() - stored.checkedAt.getTime() < DOMAIN_REFRESH_INTERVAL_MS) {
          await cache.set(normalizedDomain, stored, DOMAIN_CACHE_TTL_SECONDS);
          return stored;
        }
      }

      const fresh = await resolver.resolveDomainAuthentication(normalizedDomain);
      await repository.upsert(fresh);
      await cache.set(normalizedDomain, fresh, DOMAIN_CACHE_TTL_SECONDS);
      return fresh;
    },
  };
}
