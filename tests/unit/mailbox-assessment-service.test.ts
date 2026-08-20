import { describe, expect, it } from "vitest";
import { createMailboxAssessmentService } from "../../src/modules/health/application/mailbox-assessment-service.js";
import { RateLimitError } from "../../src/shared/errors/index.js";
import { asHealthSnapshotId, asMailboxId, asReputationAssessmentId, asTenantId, type MailboxId, type TenantId } from "../../src/shared/types/index.js";
import type { AssessmentSnapshot } from "../../src/modules/health/domain/assessment-snapshot.js";
import type {
  CreateAssessmentSnapshotInput,
  MailboxAssessmentRepository,
} from "../../src/modules/health/application/mailbox-assessment-repository.js";
import type { AssessmentInvalidationStore } from "../../src/modules/health/application/assessment-invalidation-store.js";
import type { MailboxSignalRepository } from "../../src/modules/health/application/mailbox-signal-repository.js";
import type { DomainIntelligenceService } from "../../src/modules/domain-intelligence/application/domain-intelligence-service.js";
import type { MailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import type { Mailbox } from "../../src/modules/mailbox/domain/mailbox.js";
import type { ReputationService } from "../../src/modules/reputation/application/reputation-service.js";
import type { ReputationAssessment } from "../../src/modules/reputation/domain/reputation-assessment.js";

const TENANT_ID = asTenantId("11111111-1111-1111-1111-111111111111");
const MAILBOX_ID = asMailboxId("22222222-2222-2222-2222-222222222222");

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id: MAILBOX_ID,
    tenantId: TENANT_ID,
    emailAddress: "alice@example.com",
    emailAddressCanonical: "alice@example.com",
    provider: "GMAIL",
    status: "CONNECTED",
    enabled: true,
    timezone: "UTC",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeFakeMailboxService(mailbox: Mailbox): MailboxService {
  return {
    async createMailbox() {
      throw new Error("not used");
    },
    async getMailbox() {
      return mailbox;
    },
    async listMailboxes() {
      throw new Error("not used");
    },
    async connectMailbox() {
      throw new Error("not used");
    },
    async disconnectMailbox() {
      throw new Error("not used");
    },
    async enableMailbox() {
      throw new Error("not used");
    },
    async disableMailbox() {
      throw new Error("not used");
    },
    async getCapabilities() {
      throw new Error("not used");
    },
    async getConnectionSnapshot() {
      throw new Error("not used");
    },
    async getConnectionHealth() {
      return {
        mailboxId: MAILBOX_ID,
        provider: "GMAIL",
        status: "HEALTHY",
        authenticationStatus: "HEALTHY",
        checkedAt: new Date(),
        sendCapability: true,
        receiveCapability: true,
      };
    },
    async getBaseline() {
      throw new Error("not used");
    },
  };
}

function makeFakeDomainIntelligenceService(): DomainIntelligenceService {
  return {
    async getAssessment(domain) {
      return {
        domain,
        mx: { status: "PASS", records: ["mx1." + domain] },
        spf: { status: "PASS", record: "v=spf1 -all" },
        dkim: { status: "MISSING" },
        dmarc: { status: "PASS", policy: "reject", record: "v=DMARC1; p=reject" },
        checkedAt: new Date(),
      };
    },
  };
}

function makeFakeSignalRepository(): MailboxSignalRepository & { recorded: unknown[] } {
  const recorded: unknown[] = [];
  return {
    recorded,
    async record(_tenantId, _mailboxId, signals) {
      recorded.push(...signals);
    },
    async listByMailbox() {
      return [];
    },
  };
}

function makeFakeAssessmentRepository(): MailboxAssessmentRepository & { snapshots: AssessmentSnapshot[] } {
  const snapshots: AssessmentSnapshot[] = [];
  let counter = 0;
  return {
    snapshots,
    async create(input: CreateAssessmentSnapshotInput) {
      const snapshot: AssessmentSnapshot = {
        id: asHealthSnapshotId(`snapshot-${++counter}`),
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        ...input.snapshot,
      };
      snapshots.push(snapshot);
      return snapshot;
    },
    async findLatest(tenantId: TenantId, mailboxId: MailboxId) {
      return [...snapshots].reverse().find((s) => s.tenantId === tenantId && s.mailboxId === mailboxId);
    },
    async listHistory(tenantId: TenantId, mailboxId: MailboxId, limit: number) {
      return [...snapshots]
        .reverse()
        .filter((s) => s.tenantId === tenantId && s.mailboxId === mailboxId)
        .slice(0, limit);
    },
  };
}

function makeFakeReputationService(): ReputationService {
  const emptyWindow = { eventCount: 0, deliveryRate: "UNKNOWN", bounceRate: "UNKNOWN", hardBounceRate: "UNKNOWN", softBounceRate: "UNKNOWN", throttleRate: "UNKNOWN", rejectionRate: "UNKNOWN", failureRate: "UNKNOWN", complaintRate: "UNKNOWN", unknownRate: "UNKNOWN" } as const;
  const emptyTrends = { delivery: "UNKNOWN", bounce: "UNKNOWN", throttle: "UNKNOWN", failure: "UNKNOWN", complaint: "UNKNOWN" } as const;
  const assessment: ReputationAssessment = {
    id: asReputationAssessmentId("reputation-1"),
    tenantId: TENANT_ID,
    mailboxId: MAILBOX_ID,
    status: "UNKNOWN",
    confidence: "LOW",
    factors: [],
    trends: emptyTrends,
    last24h: emptyWindow,
    last7d: emptyWindow,
    lifetime: emptyWindow,
    providerReputation: { provider: "GMAIL", status: "UNKNOWN", confidence: "LOW", factors: [], trends: emptyTrends, last24h: emptyWindow, last7d: emptyWindow, lifetime: emptyWindow },
    domainReputation: {
      domain: "example.com",
      status: "UNKNOWN",
      confidence: "LOW",
      factors: [],
      trends: emptyTrends,
      last24h: emptyWindow,
      last7d: emptyWindow,
      lifetime: emptyWindow,
      authentication: { mx: "UNKNOWN", spf: "UNKNOWN", dkim: "UNKNOWN", dmarc: "UNKNOWN" },
    },
    assessedAt: new Date(),
    createdAt: new Date(),
  };
  return {
    async assessReputation() {
      return assessment;
    },
    async getLatest() {
      return assessment;
    },
    async getHistory() {
      return [assessment];
    },
  };
}

function makeFakeInvalidationStore(): AssessmentInvalidationStore {
  const stale = new Set<string>();
  return {
    async markStale(tenantId, mailboxId) {
      stale.add(`${tenantId}:${mailboxId}`);
    },
    async isStale(tenantId, mailboxId) {
      return stale.has(`${tenantId}:${mailboxId}`);
    },
    async clear(tenantId, mailboxId) {
      stale.delete(`${tenantId}:${mailboxId}`);
    },
  };
}

function buildService(mailbox: Mailbox = makeMailbox()) {
  const assessmentRepository = makeFakeAssessmentRepository();
  const signalRepository = makeFakeSignalRepository();
  const service = createMailboxAssessmentService({
    mailboxService: makeFakeMailboxService(mailbox),
    domainIntelligenceService: makeFakeDomainIntelligenceService(),
    signalRepository,
    assessmentRepository,
    reputationService: makeFakeReputationService(),
    invalidationStore: makeFakeInvalidationStore(),
  });
  return { service, assessmentRepository, signalRepository };
}

describe("createMailboxAssessmentService", () => {
  it("getAssessment computes a fresh assessment when none exists yet", async () => {
    const { service, assessmentRepository } = buildService();
    const snapshot = await service.getAssessment(TENANT_ID, MAILBOX_ID);
    expect(snapshot.health.connection).toBe("HEALTHY");
    expect(snapshot.eligibility.decision).toBe("ELIGIBLE");
    expect(assessmentRepository.snapshots).toHaveLength(1);
  });

  it("getAssessment records signals for traceability on every refresh", async () => {
    const { service, signalRepository } = buildService();
    await service.getAssessment(TENANT_ID, MAILBOX_ID);
    expect(signalRepository.recorded.length).toBeGreaterThan(0);
  });

  it("getAssessment reuses the latest snapshot when it is still fresh", async () => {
    const { service, assessmentRepository } = buildService();
    const first = await service.getAssessment(TENANT_ID, MAILBOX_ID);
    const second = await service.getAssessment(TENANT_ID, MAILBOX_ID);
    expect(second.id).toBe(first.id);
    expect(assessmentRepository.snapshots).toHaveLength(1);
  });

  it("getAssessment recomputes when the latest snapshot has expired", async () => {
    const { service, assessmentRepository } = buildService();
    await service.getAssessment(TENANT_ID, MAILBOX_ID);
    // Backdate the stored snapshot well past the expiry window.
    assessmentRepository.snapshots[0] = {
      ...assessmentRepository.snapshots[0]!,
      assessedAt: new Date(Date.now() - 60 * 60_000),
    };
    const second = await service.getAssessment(TENANT_ID, MAILBOX_ID);
    expect(assessmentRepository.snapshots).toHaveLength(2);
    expect(second.id).not.toBe(assessmentRepository.snapshots[0]!.id);
  });

  it("refreshAssessment always recomputes when there is no prior snapshot", async () => {
    const { service, assessmentRepository } = buildService();
    await service.refreshAssessment(TENANT_ID, MAILBOX_ID);
    expect(assessmentRepository.snapshots).toHaveLength(1);
  });

  it("refreshAssessment rejects a second forced refresh within the rate-limit window", async () => {
    const { service } = buildService();
    await service.refreshAssessment(TENANT_ID, MAILBOX_ID);
    await expect(service.refreshAssessment(TENANT_ID, MAILBOX_ID)).rejects.toBeInstanceOf(RateLimitError);
  });

  it("getHistory bounds the requested limit to the configured maximum", async () => {
    const { service } = buildService();
    await service.getAssessment(TENANT_ID, MAILBOX_ID);
    const history = await service.getHistory(TENANT_ID, MAILBOX_ID, 10_000);
    expect(history.length).toBeLessThanOrEqual(100);
  });

  it("a disabled mailbox is reflected as NOT_ELIGIBLE in the computed assessment", async () => {
    const { service } = buildService(makeMailbox({ enabled: false }));
    const snapshot = await service.getAssessment(TENANT_ID, MAILBOX_ID);
    expect(snapshot.eligibility.decision).toBe("NOT_ELIGIBLE");
  });

  it("a disconnected mailbox is reflected as NOT_ELIGIBLE with elevated risk", async () => {
    const { service } = buildService(makeMailbox({ status: "DISCONNECTED" }));
    const snapshot = await service.getAssessment(TENANT_ID, MAILBOX_ID);
    expect(snapshot.health.connection).toBe("UNHEALTHY");
    expect(snapshot.eligibility.decision).toBe("NOT_ELIGIBLE");
    expect(["HIGH", "CRITICAL"]).toContain(snapshot.risk.riskLevel);
  });
});
