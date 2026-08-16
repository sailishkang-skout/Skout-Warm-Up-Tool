import { describe, expect, it, vi } from "vitest";
import { createDomainIntelligenceService } from "../../src/modules/domain-intelligence/application/domain-intelligence-service.js";
import type { DomainAuthenticationAssessment } from "../../src/modules/domain-intelligence/domain/domain-authentication.js";
import type { DomainCache } from "../../src/modules/domain-intelligence/application/domain-cache.js";
import type { DomainIntelligenceRepository } from "../../src/modules/domain-intelligence/application/domain-intelligence-repository.js";
import type { DnsResolver } from "../../src/modules/domain-intelligence/application/dns-resolver.js";

function assessment(overrides: Partial<DomainAuthenticationAssessment> = {}): DomainAuthenticationAssessment {
  return {
    domain: "example.com",
    mx: { status: "PASS", records: ["mx1.example.com"] },
    spf: { status: "PASS", record: "v=spf1 -all" },
    dkim: { status: "MISSING" },
    dmarc: { status: "PASS", policy: "reject", record: "v=DMARC1; p=reject" },
    checkedAt: new Date(),
    ...overrides,
  };
}

function makeFakeCache(): DomainCache & { store: Map<string, DomainAuthenticationAssessment> } {
  const store = new Map<string, DomainAuthenticationAssessment>();
  return {
    store,
    async get(domain) {
      return store.get(domain);
    },
    async set(domain, value) {
      store.set(domain, value);
    },
  };
}

function makeFakeRepository(): DomainIntelligenceRepository & { store: Map<string, DomainAuthenticationAssessment> } {
  const store = new Map<string, DomainAuthenticationAssessment>();
  return {
    store,
    async findByDomain(domain) {
      return store.get(domain);
    },
    async upsert(value) {
      store.set(value.domain, value);
    },
  };
}

describe("createDomainIntelligenceService", () => {
  it("returns the cached assessment without calling the resolver when the cache has it", async () => {
    const cache = makeFakeCache();
    const cached = assessment();
    cache.store.set("example.com", cached);
    const resolveFn = vi.fn();
    const service = createDomainIntelligenceService({
      cache,
      repository: makeFakeRepository(),
      resolver: { resolveDomainAuthentication: resolveFn },
    });

    const result = await service.getAssessment("example.com");
    expect(result).toEqual(cached);
    expect(resolveFn).not.toHaveBeenCalled();
  });

  it("falls back to the repository on a cache miss, and populates the cache", async () => {
    const cache = makeFakeCache();
    const repository = makeFakeRepository();
    repository.store.set("example.com", assessment({ checkedAt: new Date() }));
    const resolveFn = vi.fn();
    const service = createDomainIntelligenceService({
      cache,
      repository,
      resolver: { resolveDomainAuthentication: resolveFn },
    });

    const result = await service.getAssessment("example.com");
    expect(result.domain).toBe("example.com");
    expect(resolveFn).not.toHaveBeenCalled();
    await expect(cache.get("example.com")).resolves.toBeDefined();
  });

  it("queries real DNS when neither cache nor a fresh repository row exists, and persists the result", async () => {
    const cache = makeFakeCache();
    const repository = makeFakeRepository();
    const fresh = assessment();
    const resolveFn = vi.fn().mockResolvedValue(fresh);
    const service = createDomainIntelligenceService({ cache, repository, resolver: { resolveDomainAuthentication: resolveFn } });

    const result = await service.getAssessment("example.com");
    expect(result).toEqual(fresh);
    expect(resolveFn).toHaveBeenCalledWith("example.com");
    await expect(repository.findByDomain("example.com")).resolves.toEqual(fresh);
    await expect(cache.get("example.com")).resolves.toEqual(fresh);
  });

  it("re-resolves when the stored repository row is older than the refresh interval", async () => {
    const cache = makeFakeCache();
    const repository = makeFakeRepository();
    const staleDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days old
    repository.store.set("example.com", assessment({ checkedAt: staleDate }));
    const fresh = assessment({ checkedAt: new Date() });
    const resolveFn = vi.fn().mockResolvedValue(fresh);
    const service = createDomainIntelligenceService({ cache, repository, resolver: { resolveDomainAuthentication: resolveFn } });

    const result = await service.getAssessment("example.com");
    expect(resolveFn).toHaveBeenCalled();
    expect(result).toEqual(fresh);
  });

  it("forceRefresh always queries DNS, bypassing cache and repository freshness", async () => {
    const cache = makeFakeCache();
    cache.store.set("example.com", assessment());
    const repository = makeFakeRepository();
    repository.store.set("example.com", assessment());
    const fresh = assessment({ mx: { status: "MISSING", records: [] } });
    const resolveFn = vi.fn().mockResolvedValue(fresh);
    const service = createDomainIntelligenceService({ cache, repository, resolver: { resolveDomainAuthentication: resolveFn } });

    const result = await service.getAssessment("example.com", { forceRefresh: true });
    expect(resolveFn).toHaveBeenCalled();
    expect(result.mx.status).toBe("MISSING");
  });

  it("normalizes the domain (trims and lowercases) before every lookup", async () => {
    const cache = makeFakeCache();
    cache.store.set("example.com", assessment());
    const resolveFn = vi.fn();
    const service = createDomainIntelligenceService({
      cache,
      repository: makeFakeRepository(),
      resolver: { resolveDomainAuthentication: resolveFn },
    });

    const result = await service.getAssessment("  EXAMPLE.COM  ");
    expect(result.domain).toBe("example.com");
    expect(resolveFn).not.toHaveBeenCalled();
  });
});
