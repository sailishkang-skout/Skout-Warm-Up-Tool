import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { buildServices } from "../../src/composition/build-services.js";
import { createConversationService } from "../../src/modules/conversations/application/conversation-service.js";
import { createClassificationWorker } from "../../src/modules/conversations/application/classification-worker.js";
import { createHybridConversationClassifier } from "../../src/modules/conversations/application/conversation-classifier.js";
import { PostgresClassificationRepository } from "../../src/modules/conversations/infrastructure/postgres-classification-repository.js";
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
import { PermanentError } from "../../src/shared/errors/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { loadConfig } from "../../src/shared/config/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { createApiCredentialService } from "../../src/modules/auth/application/api-credential-service.js";
import { PostgresApiCredentialRepository } from "../../src/modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../../src/modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createFakeAuditEventRecorder } from "../support/fake-audit-event-recorder.js";
import {
  createTestDatabaseHandle,
  createTestRedisHandle,
  ensureTestDatabaseExists,
  flushTestRedis,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";
import type { ConversationClassifier } from "../../src/modules/conversations/application/conversation-classifier.js";
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

async function setup(classifier: ConversationClassifier) {
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
  const worker = createClassificationWorker({
    conversationService,
    messageRepository,
    classificationRepository,
    classifier,
    classifierVersion: CLASSIFIER_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    modelName: "test-model",
    maxInputChars: 4000,
    auditRecorder,
    logger,
  });
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Quality Co" });
  const mailbox = await mailboxService.createMailbox(tenant.id, { emailAddress: "me@skout.test", provider: "GMAIL" });
  return { conversationService, worker, mailbox, tenant, auditRecorder, classificationRepository };
}

describe("classification quality persistence", () => {
  it("enforces uniqueness per message + classifier version + taxonomy version", async () => {
    const { conversationService, mailbox, classificationRepository } = await setup(
      createHybridConversationClassifier({ supplementDeterministic: false }),
    );
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "uniq",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe",
      sentAt: new Date(),
    });
    await handle.database.withTransaction(async (client) => {
      await classificationRepository.enqueueOnClient(client, {
        tenantId: mailbox.tenantId,
        conversationId: persisted.conversation.id,
        messageId: persisted.message.id,
        classifierVersion: CLASSIFIER_VERSION,
        taxonomyVersion: TAXONOMY_VERSION,
      });
    });
    const count = await handle.database.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM conversation_message_classifications",
    );
    expect(count[0]?.n).toBe("1");
  });

  it("preserves a historical classification when a new taxonomy version is enqueued", async () => {
    const hybrid = createHybridConversationClassifier({ supplementDeterministic: false });
    const { conversationService, mailbox, classificationRepository } = await setup(hybrid);
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "hist",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe",
      sentAt: new Date(),
    });
    await handle.database.withTransaction(async (client) => {
      await classificationRepository.enqueueOnClient(client, {
        tenantId: mailbox.tenantId,
        conversationId: persisted.conversation.id,
        messageId: persisted.message.id,
        classifierVersion: CLASSIFIER_VERSION,
        taxonomyVersion: "classification-taxonomy/v2-test",
      });
    });
    const count = await handle.database.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM conversation_message_classifications",
    );
    expect(count[0]?.n).toBe("2");
  });

  it("projects domain facts, audits without bodies, and does not duplicate facts", async () => {
    const { conversationService, worker, mailbox, auditRecorder } = await setup(
      createHybridConversationClassifier({ supplementDeterministic: false }),
    );
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "facts",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "Interested, but please unsubscribe me.",
      sentAt: new Date(),
    });
    expect((await worker.runTick("w1")).classified).toBe(1);
    expect((await worker.runTick("w1")).classified).toBe(0);
    const facts = await worker.listDomainFacts(mailbox.tenantId, persisted.conversation.id, 50, 0, undefined);
    expect(facts.map((row) => row.factType).sort()).toEqual(["MESSAGE_RECEIVED", "POSITIVE_INTEREST", "UNSUBSCRIBE"].sort());
    expect(auditRecorder.events.some((event) => event.eventType === "DOMAIN_FACT_CREATED")).toBe(true);
    expect(JSON.stringify(auditRecorder.events)).not.toContain("unsubscribe me");
    const factCount = await handle.database.query<{ n: string }>("SELECT count(*)::text AS n FROM conversation_domain_facts");
    expect(factCount[0]?.n).toBe("3");
  });

  it("isolates domain facts by tenant", async () => {
    const first = await setup(createHybridConversationClassifier({ supplementDeterministic: false }));
    const other = await new PostgresTenantRepository(handle.database).create({ name: "Other" });
    const persisted = await first.conversationService.persistNormalized(first.mailbox.tenantId, first.mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "iso-q",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe",
      sentAt: new Date(),
    });
    await first.worker.runTick("w1");
    await expect(first.worker.listDomainFacts(other.id, persisted.conversation.id, 10, 0, undefined)).rejects.toThrow();
  });

  it("retries malformed AI once then persists UNKNOWN, never a positive fact", async () => {
    let calls = 0;
    const classifier: ConversationClassifier = {
      async classify() {
        calls += 1;
        throw new PermanentError("Classifier returned invalid JSON");
      },
    };
    const { conversationService, worker, mailbox } = await setup(classifier);
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "malformed",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      textBody: "hello there",
      sentAt: new Date(),
    });
    expect((await worker.runTick("w1")).classified).toBe(0);
    await handle.database.query("UPDATE conversation_message_classifications SET next_attempt_at = now() - interval '1 second'");
    expect((await worker.runTick("w1")).classified).toBe(1);
    expect(calls).toBe(2);
    const saved = await worker.getMessageClassification(mailbox.tenantId, persisted.conversation.id, persisted.message.id);
    expect(saved.primaryLabel).toBe("UNKNOWN");
    const domain = await worker.listDomainFacts(mailbox.tenantId, persisted.conversation.id, 50, 0, undefined);
    expect(domain.map((row) => row.factType)).toEqual(["MESSAGE_RECEIVED"]);
  });

  it("is safe under concurrent hybrid workers", async () => {
    const classifier = createHybridConversationClassifier({ supplementDeterministic: false });
    const { conversationService, worker, mailbox } = await setup(classifier);
    await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "conc-q",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe",
      sentAt: new Date(),
    });
    const [a, b] = await Promise.all([worker.runTick("wa"), worker.runTick("wb")]);
    expect(a.classified + b.classified).toBe(1);
    const count = await handle.database.query<{ n: string }>("SELECT count(*)::text AS n FROM conversation_message_classifications");
    expect(count[0]?.n).toBe("1");
  });
});

describe("inbound to read API integration", () => {
  it("classifies deterministically without AI and exposes facts over GET without duplicating", async () => {
    const tenantRepository = new PostgresTenantRepository(handle.database);
    const credentialRepository = new PostgresApiCredentialRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const credentialService = createApiCredentialService({
      repository: credentialRepository,
      auditRecorder,
      pepper: testConfig.security.apiKeyPepper,
    });
    const tenant = await tenantRepository.create({ name: "Http Quality" });
    const issued = await credentialService.issueCredential(tenant.id, { name: "Test" });
    const app = await buildApp(testConfig, logger, handle.database, redis);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mailboxes",
      headers: { authorization: `Bearer ${issued.apiKey}` },
      payload: { emailAddress: "q@skout.test", provider: "GMAIL" },
    });
    expect(created.statusCode).toBe(201);
    const mailboxId = created.json().id as string;
    const services = buildServices(testConfig, logger, handle.database, redis);
    const persisted = await services.conversationService.persistNormalized(tenant.id, asMailboxId(mailboxId), {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "http-det",
      sender: "lead@example.com",
      recipients: ["q@skout.test"],
      textBody: "Interested, but please unsubscribe me.",
      sentAt: new Date(),
    });
    expect((await services.classificationWorker.runTick("http-w")).classified).toBe(1);
    expect((await services.classificationWorker.runTick("http-w")).classified).toBe(0);

    const classified = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persisted.conversation.id}/classifications?label=UNSUBSCRIBE`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(classified.statusCode).toBe(200);
    expect(classified.json().classifications).toHaveLength(1);
    expect(classified.json().classifications[0].primaryLabel).toBe("UNSUBSCRIBE");
    expect(classified.json().classifications[0].labels).toEqual(expect.arrayContaining(["POSITIVE_INTEREST", "UNSUBSCRIBE"]));
    expect(classified.json().classifications[0].classifierType).toBe("DETERMINISTIC");

    const domain = await app.inject({
      method: "GET",
      url: `/api/v1/conversations/${persisted.conversation.id}/domain-facts?label=UNSUBSCRIBE`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(domain.statusCode).toBe(200);
    expect(domain.json().facts).toHaveLength(1);
    expect(domain.json().facts[0].factType).toBe("UNSUBSCRIBE");

    const factCount = await handle.database.query<{ n: string }>("SELECT count(*)::text AS n FROM conversation_domain_facts");
    expect(Number(factCount[0]?.n)).toBeGreaterThanOrEqual(3);
    await app.close();
  });
});
