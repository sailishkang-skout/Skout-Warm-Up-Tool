import type { RedisClient } from "../../../shared/redis/index.js";
import type { DomainAuthenticationAssessment } from "../domain/domain-authentication.js";
import type { DomainCache } from "../application/domain-cache.js";

const KEY_PREFIX = "domain-intelligence:";

export function createRedisDomainCache(redis: RedisClient): DomainCache {
  return {
    async get(domain: string): Promise<DomainAuthenticationAssessment | undefined> {
      const raw = await redis.get(KEY_PREFIX + domain);
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw) as DomainAuthenticationAssessment;
      // Dates round-trip through JSON as strings — restore them so callers
      // get the same shape whether the assessment came from cache or DNS.
      return { ...parsed, checkedAt: new Date(parsed.checkedAt) };
    },

    async set(domain: string, assessment: DomainAuthenticationAssessment, ttlSeconds: number): Promise<void> {
      await redis.set(KEY_PREFIX + domain, JSON.stringify(assessment), "EX", ttlSeconds);
    },
  };
}
