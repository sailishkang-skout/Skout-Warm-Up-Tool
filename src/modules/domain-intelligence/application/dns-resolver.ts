import type { DomainAuthenticationAssessment } from "../domain/domain-authentication.js";

/**
 * The only thing application code depends on for DNS — never `node:dns`
 * directly (same boundary principle as `Database`/`RedisClient`). Performs
 * the actual MX/SPF/DKIM/DMARC lookups for one domain and returns an
 * already-normalized assessment; see
 * infrastructure/node-dns-resolver.ts for the real implementation and its
 * timeout/error-mapping behavior.
 */
export interface DnsResolver {
  resolveDomainAuthentication(domain: string): Promise<DomainAuthenticationAssessment>;
}
