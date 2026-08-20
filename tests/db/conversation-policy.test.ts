import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { buildServices } from "../../src/composition/build-services.js";
import { createConversationService } from "../../src/modules/conversations/application/conversation-service.js";
import { createClassificationWorker } from "../../src/modules/conversations/application/classification-worker.js";
import { createConversationPolicyWorker } from "../../src/modules/conversations/application/policy-evaluation-worker.js";
import { createHybridConversationClassifier } from "../../src/modules/conversations/application/conversation-classifier.js";
import { PostgresClassificationRepository } from "../../src/modules/conversations/infrastructure/postgres-classification-repository.js";
import { PostgresConversationPolicyRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-policy-repository.js";
import { PostgresConversationMessageRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-message-repository.js";
import { PostgresConversationRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-repository.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { asMailboxId } from "../../src/shared/types/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { loadConfig } from "../../src/shared/config/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
import { PostgresApiCredentialRepository } from "../../src/modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createFakeAuditEventRecorder } from "../support/fake-audit-event-recorder.js";
import {
  CONVERSATION_POLICY_TAXONOMY_VERSION,
  CONVERSATION_POLICY_VERSION,
} from "../../src/modules/conversations/domain/policy-signal-taxonomy.js";
import {
  createTestDatabaseHandle,
  createTestRedisHandle,
  ensureTestDatabaseExists,
  flushTestRedis,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";
import type { RedisClient } from "../../src/shared/redis/index.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
const CLASSIFIER_VERSION = "conversation-classifier/v1";
const TAXONOMY_VERSION = "classification-taxonomy/v1";
const testConfig = { ...loadConfig({ NODE_ENV: "test" }), log: { level: "silent" as const } };

let handle: TestDatabaseHandle;
let redis: RedisClient;

beforeAll(async () => {
  await ensureTestDatabaseExists();
  handle = createTestDatabaseHandle();
  redis = createTestRedisHandle();
  await resetSchema(handle.pool);
  await runMigrations(handle.pool, logger);
}, 30_000);

beforeEach(async () => {
  await truncateAppTables(handle.pool);
  await flushTestRedis(redis);
});

afterAll(async () => {
  if (handle) await handle.database.close();
  if (redis) redis.disconnect();
});

async function setup(policyVersion = CONVERSATION_POLICY_VERSION) {
  const auditRecorder = createFakeAuditEventRecorder();
  const registry = createProviderRegistry();
  registry.register(new GmailAdapter());
  const mailboxService = createMailboxService({
    database: handle.database,
    mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
    providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
    providerRegistry: registry,
    credentialStore: createInMemoryProviderCredentialStore({ isProduction: false }),
    auditRecorder,
  });
  const classificationRepository = new PostgresClassificationRepository(handle.database);
  const policyRepository = new PostgresConversationPolicyRepository(handle.database);
  const messageRepository = new PostgresConversationMessageRepository(handle.database);
  const conversationService = createConversationService({
    database: handle.database,
    mailboxService,
    conversationRepository: new PostgresConversationRepository(handle.database),
    messageRepository,
    auditRecorder,
    classificationRepository,
    classifierVersion: CLASSIFIER_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
  });
  const classificationWorker = createClassificationWorker({
    conversationService,
    messageRepository,
    classificationRepository,
    classifier: createHybridConversationClassifier({ supplementDeterministic: false }),
    classifierVersion: CLASSIFIER_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    modelName: "test-model",
    maxInputChars: 4000,
    auditRecorder,
    logger,
  });
  const policyWorker = createConversationPolicyWorker({
    conversationService,
    policyRepository,
    policyVersion,
    taxonomyVersion: CONVERSATION_POLICY_TAXONOMY_VERSION,
    auditRecorder,
    logger,
  });
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Policy Co" });
  const mailbox = await mailboxService.createMailbox(tenant.id, { emailAddress: "me@skout.test", provider: "GMAIL" });
  return { conversationService, classificationWorker, policyWorker, policyRepository, mailbox, tenant, auditRecorder };
}

describe("conversation policy persistence", () => {
  it("persists an evaluation and signals from domain facts without sending or suppressing", async () => {
    const { conversationService, classificationWorker, policyWorker, mailbox, auditRecorder } = await setup();
    await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "pol-1",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe",
      sentAt: new Date(),
    });
    expect((await classificationWorker.runTick("c1")).classified).toBe(1);
    const tick = await policyWorker.runTick("p1");
    expect(tick.evaluated).toBe(1);

    const evaluations = await handle.database.query<{ status: string }>(
      "SELECT status FROM conversation_policy_evaluations",
    );
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.status).toBe("EVALUATED");

    const signals = await handle.database.query<{ signal: string }>(
      "SELECT signal FROM conversation_policy_signals ORDER BY signal",
    );
    expect(signals.map((row) => row.signal)).toEqual(["CONTACT_SUPPRESSION_REQUIRED"]);

    const intents = await handle.database.query("SELECT id FROM warmup_execution_intents");
    expect(intents).toEqual([]);
    expect(auditRecorder.events.some((event) => event.eventType === "POLICY_EVALUATED")).toBe(true);
    expect(auditRecorder.events.some((event) => event.eventType === "POLICY_SIGNAL_CREATED")).toBe(true);
    for (const event of auditRecorder.events.filter((row) => row.eventType.startsWith("POLICY_"))) {
      const metadata = JSON.stringify(event.metadata);
      expect(metadata).not.toMatch(/please unsubscribe/i);
    }
  });

  it("enforces uniqueness for the same message, policy version, and fact set", async () => {
    const { conversationService, classificationWorker, policyWorker, mailbox } = await setup();
    await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "pol-uniq",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "out of office until Monday",
      sentAt: new Date(),
    });
    await classificationWorker.runTick("c1");
    await policyWorker.runTick("p1");
    await policyWorker.runTick("p1");
    const count = await handle.database.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM conversation_policy_evaluations",
    );
    expect(count[0]?.n).toBe("1");
  });

  it("keeps historical evaluations when the policy version changes", async () => {
    const first = await setup("conversation-policy/v1");
    await first.conversationService.persistNormalized(first.mailbox.tenantId, first.mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "pol-hist",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "out of office until Monday",
      sentAt: new Date(),
    });
    await first.classificationWorker.runTick("c1");
    await first.policyWorker.runTick("p1");
    const second = createConversationPolicyWorker({
      conversationService: first.conversationService,
      policyRepository: first.policyRepository,
      policyVersion: "conversation-policy/v2",
      taxonomyVersion: CONVERSATION_POLICY_TAXONOMY_VERSION,
      auditRecorder: first.auditRecorder,
      logger,
    });
    await second.runTick("p2");
    const versions = await handle.database.query<{ policy_version: string }>(
      "SELECT policy_version FROM conversation_policy_evaluations ORDER BY policy_version",
    );
    expect(versions.map((row) => row.policy_version)).toEqual(["conversation-policy/v1", "conversation-policy/v2"]);
  });

  it("isolates policy signals by tenant", async () => {
    const first = await setup();
    const other = await new PostgresTenantRepository(handle.database).create({ name: "Other Policy" });
    const persisted = await first.conversationService.persistNormalized(first.mailbox.tenantId, first.mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "pol-iso",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe",
      sentAt: new Date(),
    });
    await first.classificationWorker.runTick("c1");
    await first.policyWorker.runTick("p1");
    await expect(
      first.policyWorker.listPolicySignals(other.id, persisted.conversation.id, 10, 0, undefined),
    ).rejects.toThrow();
  });

  it("is safe under concurrent policy workers", async () => {
    const { conversationService, classificationWorker, policyWorker, mailbox } = await setup();
    await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "pol-conc",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe",
      sentAt: new Date(),
    });
    await classificationWorker.runTick("c1");
    const [a, b] = await Promise.all([policyWorker.runTick("pa"), policyWorker.runTick("pb")]);
    expect(a.evaluated + b.evaluated).toBe(1);
    const count = await handle.database.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM conversation_policy_evaluations",
    );
    expect(count[0]?.n).toBe("1");
    const signalCount = await handle.database.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM conversation_policy_signals",
    );
    expect(signalCount[0]?.n).toBe("1");
  });
});

describe("classified facts to policy API", () => {
  it("classifies interest+unsubscribe, evaluates suppression-only signals, and exposes them over GET", async () => {
    const tenantRepository = new PostgresTenantRepository(handle.database);
    const credentialRepository = new PostgresApiCredentialRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const credentialService = createApiCredentialService({
      repository: credentialRepository,
      auditRecorder,
      pepper: testConfig.security.apiKeyPepper,
    });
    const tenant = await tenantRepository.create({ name: "Http Policy" });
    const issued = await credentialService.issueCredential(tenant.id, { name: "Test" });
    const app = await buildApp(testConfig, logger, handle.database, redis);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${issued.apiKey}` },
      payload: { emailAddress: "p@skout.test", provider: "GMAIL" },
    });
    expect(created.statusCode).toBe(201);
    const mailboxId = created.json().id as string;
    const services = buildServices(testConfig, logger, handle.database, redis);
    const persisted = await services.conversationService.persistNormalized(tenant.id, asMailboxId(mailboxId), {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "http-pol",
      sender: "lead@example.com",
      recipients: ["p@skout.test"],
      textBody: "Interested, but please unsubscribe me.",
      sentAt: new Date(),
    });
    expect((await services.classificationWorker.runTick("http-c")).classified).toBe(1);
    expect((await services.policyWorker.runTick("http-p")).evaluated).toBe(1);

    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/conversations/${persisted.conversation.id}/policy-signals`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(denied.statusCode).toBeGreaterThanOrEqual(400);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persisted.conversation.id}/policy-signals?signal=CONTACT_SUPPRESSION_REQUIRED`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().signals).toHaveLength(1);
    expect(listed.json().signals[0].signal).toBe("CONTACT_SUPPRESSION_REQUIRED");
    expect(listed.json().signals[0].priority).toBe("CRITICAL");
    expect(listed.json().signals[0].source).toBe("UNSUBSCRIBE");
    expect(listed.json().signals[0].policyVersion).toBe(CONVERSATION_POLICY_VERSION);

    const byMessage = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persisted.conversation.id}/messages/${persisted.message.id}/policy-signals`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(byMessage.statusCode).toBe(200);
    expect(byMessage.json().signals.map((row: { signal: string }) => row.signal)).toEqual([
      "CONTACT_SUPPRESSION_REQUIRED",
    ]);

    const intents = await handle.database.query("SELECT id FROM warmup_execution_intents");
    expect(intents).toEqual([]);
    const tables = await handle.database.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relkind = 'r' AND relname LIKE '%suppression%'`,
    );
    expect(tables).toEqual([]);
    await app.close();
  });
});
