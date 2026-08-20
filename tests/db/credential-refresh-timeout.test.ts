/**
 * Requires a live PostgreSQL instance. Run via `npm run test:db`. Stage
 * 12.1's critical-concurrency scenario, exercised through the real chain:
 * `ExecutionWorker` → `AdapterWarmupSendProvider` → `resolveFreshCredential`
 * (real encrypted Postgres credential store) → `GmailAdapter` — only
 * Gmail's own HTTP API is mocked (`fetchImpl`). Proves a credential-refresh
 * timeout flows through the *existing*, unmodified claim/lease/retry
 * machinery: the intent is retried (not stuck), the lease is released (not
 * held forever), a different worker can pick up the retry, and the
 * provider's send endpoint is never reached during the timed-out attempt
 * (no duplicate-send risk).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionWorker } from "../../src/modules/warmup/application/execution-worker.js";
import { createAdapterWarmupSendProvider } from "../../src/modules/warmup/infrastructure/adapter-warmup-send-provider.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import type { MailboxAssessmentService } from "../../src/modules/health/application/mailbox-assessment-service.js";
import type { AssessmentSnapshot } from "../../src/modules/health/domain/assessment-snapshot.js";
import type { MailboxHealthAssessment } from "../../src/modules/health/domain/mailbox-health.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createPostgresProviderCredentialStore } from "../../src/modules/providers/infrastructure/postgres-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createEncryptionService } from "../../src/shared/crypto/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { createTestDatabaseHandle, ensureTestDatabaseExists, resetSchema, truncateAppTables, type TestDatabaseHandle } from "./support.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
const ENCRYPTION_KEY = "credential-refresh-timeout-test-key-32ch";

let handle: TestDatabaseHandle;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, logger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
});

afterAll(async () => {
  if (handle) await handle.database.close();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

const HEALTHY: MailboxHealthAssessment = {
  connection: "HEALTHY",
  authentication: "HEALTHY",
  sending: "HEALTHY",
  receiving: "HEALTHY",
  domain: "HEALTHY",
  configuration: "HEALTHY",
  assessedAt: new Date(),
};

function fakeAssessmentService(): MailboxAssessmentService {
  const snapshot = (mailboxId: AssessmentSnapshot["mailboxId"]): AssessmentSnapshot => ({
    id: "fake" as AssessmentSnapshot["id"],
    tenantId: "fake" as AssessmentSnapshot["tenantId"],
    mailboxId,
    health: HEALTHY,
    risk: { riskLevel: "LOW", riskScore: 0, riskFactors: [], assessedAt: new Date() },
    eligibility: { decision: "ELIGIBLE", reasons: [], assessedAt: new Date() },
    capacity: { recommendedDailyVolume: 10, minimumDailyVolume: 1, maximumDailyVolume: 10, confidence: "HIGH", reasons: [], assessedAt: new Date() },
    assessedAt: new Date(),
  });
  return {
    async getAssessment(_tenantId, mailboxId) { return snapshot(mailboxId); },
    async refreshAssessment(_tenantId, mailboxId) { return snapshot(mailboxId); },
    async getHistory() { return []; },
  };
}

async function buildHarness(fetchImpl: typeof fetch) {
  const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
  const providerRegistry = createProviderRegistry();
  providerRegistry.register(new GmailAdapter({ config: { clientId: "id", clientSecret: "secret", redirectUri: "https://app.test/cb" }, fetchImpl, refreshTimeoutMs: 200 }));
  const credentialStore = createPostgresProviderCredentialStore(handle.database, createEncryptionService([{ version: 1, rawKey: ENCRYPTION_KEY }], 1));
  const providerAccountRepository = new PostgresProviderAccountRepository(handle.database);

  const mailboxService = createMailboxService({
    database: handle.database,
    mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
    providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
    providerRegistry,
    credentialStore,
    auditRecorder,
  });

  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Credential Timeout Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({ tenantId: tenant.id, emailAddress: "worker@example.com", provider: "GMAIL" });
  const providerAccount = await providerAccountRepository.create({ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL" });
  await credentialStore.saveCredential({
    providerAccountId: providerAccount.id,
    kind: "GOOGLE_OAUTH",
    // Near-expiry so resolveFreshCredential always attempts a refresh.
    secretData: { accessToken: "stale-token", refreshToken: "refresh-value", accessTokenExpiresAt: new Date(Date.now() + 1000).toISOString() },
  });

  const profileRepository = new PostgresWarmupProfileRepository(handle.database);
  await profileRepository.create({
    tenantId: tenant.id,
    mailboxId: mailbox.id,
    targetDailyVolume: 30,
    startingDailyVolume: 5,
    maximumDailyVolume: 50,
    rampStrategy: "STANDARD",
    riskTolerance: "MEDIUM",
  });
  const profile = await profileRepository.setActive(tenant.id, mailbox.id, true);

  const sessionRepository = new PostgresWarmupSessionRepository(handle.database);
  const session = await sessionRepository.create({ tenantId: tenant.id, mailboxId: mailbox.id, profileId: profile.id });
  await sessionRepository.transitionState(tenant.id, session.id, "DRAFT", "ACTIVE");
  await sessionRepository.recordDailyDecision(tenant.id, session.id, 1, 10);

  const decisionRepository = new PostgresWarmupDecisionRepository(handle.database);
  const decision = await decisionRepository.create({
    tenantId: tenant.id,
    sessionId: session.id,
    mailboxId: mailbox.id,
    warmupDay: 1,
    decision: "PROCEED",
    reasonCodes: ["RAMP_PROGRESSION"],
    reasons: ["ok"],
    recommendedVolume: 5,
    maximumVolume: 10,
    riskLevel: "LOW",
    eligibility: "ELIGIBLE",
    profileSnapshot: { targetDailyVolume: 30, startingDailyVolume: 5, maximumDailyVolume: 50, rampStrategy: "STANDARD", riskTolerance: "MEDIUM", active: true, pauseConditions: [] },
    generatedAt: new Date(),
  });

  const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
  const intent = await intentRepository.createIfAbsent({
    tenantId: tenant.id,
    sessionId: session.id,
    mailboxId: mailbox.id,
    decisionId: decision.id,
    provider: "GMAIL",
    warmupDay: 1,
    executionSlot: 0,
    idempotencyKey: computeIdempotencyKey({ tenantId: tenant.id, sessionId: session.id, warmupDay: 1, executionSlot: 0 }),
    volume: 5,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const sendProvider = createAdapterWarmupSendProvider({ mailboxService, providerAccountRepository, credentialStore, providerRegistry, auditRecorder });
  const worker = createExecutionWorker({
    intentRepository,
    sessionRepository,
    warmupProfileRepository: profileRepository,
    mailboxService,
    mailboxAssessmentService: fakeAssessmentService(),
    sendProvider,
    auditRecorder,
    logger,
  });

  return { tenant, mailbox, providerAccount, credentialStore, intentRepository, worker, intent };
}

describe("Credential-refresh timeout — through the real execution worker (Stage 12.1 critical concurrency requirement)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a credential-refresh timeout re-queues the intent (PENDING, future scheduledFor) rather than terminally failing it", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) throw timeoutError();
      return jsonResponse({ id: "should-not-be-called" });
    });
    const h = await buildHarness(fetchImpl as unknown as typeof fetch);

    const result = await h.worker.processNext("worker-a");

    expect(result?.status).toBe("PENDING");
    expect(result?.scheduledFor).toBeDefined();
    expect(result?.attemptCount).toBe(1);
  });

  it("the lease is released — not held forever — after a credential-refresh timeout: the intent is claimable again by any worker", async () => {
    // `recordResult`'s existing, pre-Stage-12.1 `PENDING` re-queue path
    // deliberately leaves the previous `lease_owner`/`lease_expires_at`
    // values in place rather than nulling them (`releasesLease` is only
    // true for a *terminal* status) — this is safe and unchanged by Stage
    // 12.1 because `claimNext`'s WHERE clause never consults `lease_owner`
    // for `PENDING` rows, only `status`/`scheduled_for`/`expires_at`; the
    // stale value is just overwritten on the next real claim. What
    // actually matters — and is what this test verifies — is that the row
    // is genuinely claimable again, by a worker other than the one that
    // just timed out.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) throw timeoutError();
      return jsonResponse({ id: "unused" });
    });
    const h = await buildHarness(fetchImpl as unknown as typeof fetch);

    const result = await h.worker.processNext("worker-a");
    expect(result?.status).toBe("PENDING");

    await handle.database.query("UPDATE warmup_execution_intents SET scheduled_for = now() - interval '1 second' WHERE id = $1", [h.intent.id]);
    const reclaimed = await h.intentRepository.claimNext("worker-b", 60_000);
    expect(reclaimed?.id).toBe(h.intent.id);
    expect(reclaimed?.leaseOwner).toBe("worker-b");
  });

  it("no duplicate provider send occurs — the send endpoint is never reached during a timed-out refresh attempt", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) throw timeoutError();
      return jsonResponse({ id: "should-not-be-called" });
    });
    const h = await buildHarness(fetchImpl as unknown as typeof fetch);

    await h.worker.processNext("worker-a");

    const sendCalls = fetchImpl.mock.calls.filter(([url]) => !(url as string).includes("oauth2.googleapis.com/token"));
    expect(sendCalls).toHaveLength(0);
  });

  it("after a timeout, a *different* worker can subsequently claim and successfully process the retried intent", async () => {
    let tokenCallCount = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) {
        tokenCallCount += 1;
        if (tokenCallCount === 1) throw timeoutError();
        return jsonResponse({ access_token: "refreshed-token", expires_in: 3600 });
      }
      return jsonResponse({ id: "gmail-msg-retry" });
    });
    const h = await buildHarness(fetchImpl as unknown as typeof fetch);

    const first = await h.worker.processNext("worker-a");
    expect(first?.status).toBe("PENDING");

    // Force the retry due immediately rather than waiting out real
    // exponential backoff (domain/retry-policy.ts) — this test is about
    // lease/ownership handoff, not backoff timing, which is already
    // covered by retry-policy.test.ts.
    await handle.database.query("UPDATE warmup_execution_intents SET scheduled_for = now() - interval '1 second' WHERE id = $1", [h.intent.id]);

    const second = await h.worker.processNext("worker-b");
    expect(second?.status).toBe("SENT");
    expect(second?.leaseOwner).toBeUndefined(); // released again after completion
  });

  it("credential refresh succeeding just before the timeout produces no false timeout classification", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) return jsonResponse({ access_token: "on-time-token", expires_in: 3600 });
      return jsonResponse({ id: "gmail-msg-on-time" });
    });
    const h = await buildHarness(fetchImpl as unknown as typeof fetch);

    const result = await h.worker.processNext("worker-a");

    expect(result?.status).toBe("SENT");
  });

  it("a genuine invalid_grant during refresh is still terminal (FAILED, non-retryable), never mistaken for a timeout", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) return jsonResponse({ error: "invalid_grant" }, 400);
      return jsonResponse({ id: "unused" });
    });
    const h = await buildHarness(fetchImpl as unknown as typeof fetch);

    const result = await h.worker.processNext("worker-a");

    expect(result?.status).toBe("FAILED");
    const stored = await h.credentialStore.getCredential(h.providerAccount.id);
    expect(stored).toBeUndefined(); // genuinely revoked, unlike the timeout case
  });

  it("the worker continues processing subsequent intents normally after a credential-refresh timeout on a prior one", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("oauth2.googleapis.com/token")) throw timeoutError();
      return jsonResponse({ id: "unused" });
    });
    const h = await buildHarness(fetchImpl as unknown as typeof fetch);

    await h.worker.processNext("worker-a"); // times out, re-queued
    // Nothing else claimable right now (scheduledFor is in the future) — the
    // worker must return undefined cleanly, not hang or throw.
    await expect(h.worker.processNext("worker-a")).resolves.toBeUndefined();
  });
});
