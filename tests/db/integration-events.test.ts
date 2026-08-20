import { randomUUID } from "node:crypto";
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
import {
  insertIntegrationEvent,
  PostgresIntegrationEventRepository,
} from "../../src/modules/conversations/infrastructure/postgres-integration-event-repository.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { asConversationId, asIntegrationEventId, asMailboxId, asTenantId } from "../../src/shared/types/index.js";
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
import { mapPolicySignalToIntegrationEvent } from "../../src/modules/conversations/domain/integration-event-mapping.js";
import {
  ACTION_INTEGRATION_EVENT_TYPES,
  INTEGRATION_EVENT_SOURCE,
} from "../../src/modules/conversations/domain/integration-event-taxonomy.js";
import type { IntegrationEventEnvelope } from "../../src/modules/conversations/domain/integration-event.js";
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
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Integration Co" });
  const mailbox = await mailboxService.createMailbox(tenant.id, { emailAddress: "me@skout.test", provider: "GMAIL" });
  return { conversationService, classificationWorker, policyWorker, mailbox, tenant };
}

function sampleEnvelope(
  tenantId: string,
  conversationId: string,
  idempotencyKey: string,
  eventId = randomUUID(),
  overrides: {
    occurredAt?: string;
    eventVersion?: number;
    eventType?: IntegrationEventEnvelope["eventType"];
    payloadExtra?: Record<string, unknown>;
  } = {},
): IntegrationEventEnvelope {
  const occurredAt = overrides.occurredAt ?? new Date().toISOString();
  const eventVersion = overrides.eventVersion ?? 1;
  const eventType = overrides.eventType ?? "CONTACT_SUPPRESSION_REQUIRED";
  return {
    eventId: asIntegrationEventId(eventId),
    eventType,
    eventVersion,
    tenantId: asTenantId(tenantId),
    source: INTEGRATION_EVENT_SOURCE,
    conversationId: asConversationId(conversationId),
    occurredAt,
    policyVersion: CONVERSATION_POLICY_VERSION,
    payload: {
      tenantId,
      conversationId,
      reason: "UNSUBSCRIBE",
      policyVersion: CONVERSATION_POLICY_VERSION,
      occurredAt,
      priority: "CRITICAL",
      ...overrides.payloadExtra,
    } as IntegrationEventEnvelope["payload"],
    idempotencyKey,
  };
}

describe("integration event persistence", () => {
  it("writes policy signals and outbox events in the same evaluation transaction", async () => {
    const { conversationService, classificationWorker, policyWorker, mailbox } = await setup();
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "int-1",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe me, though I was interested",
      sentAt: new Date(),
    });
    expect((await classificationWorker.runTick("c1")).classified).toBe(1);
    expect((await policyWorker.runTick("p1")).evaluated).toBe(1);

    const signals = await handle.database.query<{ id: string; signal: string }>(
      "SELECT id, signal FROM conversation_policy_signals",
    );
    const events = await handle.database.query<{
      event_type: string;
      source_policy_signal_id: string;
      payload: { contactIdentifier?: string; textBody?: string };
      status: string;
    }>("SELECT event_type, source_policy_signal_id, payload, status FROM integration_events_outbox");

    expect(signals.map((row) => row.signal)).toEqual(["CONTACT_SUPPRESSION_REQUIRED"]);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe("CONTACT_SUPPRESSION_REQUIRED");
    expect(events[0]?.source_policy_signal_id).toBe(signals[0]?.id);
    expect(events[0]?.status).toBe("RECORDED");
    expect(events[0]?.payload.contactIdentifier).toBe("lead@example.com");
    expect(events[0]?.payload).not.toHaveProperty("textBody");
    const stored = await handle.database.query<{
      source: string;
      mailbox_id: string;
    }>("SELECT source, mailbox_id FROM integration_events_outbox");
    expect(stored[0]?.source).toBe("conversation-intelligence");
    expect(stored[0]?.mailbox_id).toBe(mailbox.id);
    expect(ACTION_INTEGRATION_EVENT_TYPES.some((type) => type === events[0]?.event_type)).toBe(false);

    const mapped = mapPolicySignalToIntegrationEvent({
      tenantId: mailbox.tenantId,
      conversationId: persisted.conversation.id,
      messageId: persisted.message.id,
      policySignalId: signals[0]?.id ?? "",
      signal: "CONTACT_SUPPRESSION_REQUIRED",
      priority: "CRITICAL",
      sourceFactType: "UNSUBSCRIBE",
      policyVersion: CONVERSATION_POLICY_VERSION,
      occurredAt: new Date(),
    });
    expect(mapped?.eventType).toBe("CONTACT_SUPPRESSION_REQUIRED");
  });

  it("rolls back the signal when the outbox insert cannot commit", async () => {
    const { conversationService, mailbox } = await setup();
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "int-tx",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "hello",
      sentAt: new Date(),
    });
    await expect(
      handle.database.withTransaction(async (tx) => {
        await tx.query(
          `INSERT INTO conversation_policy_evaluations (
             tenant_id, conversation_id, source_message_id, policy_version, taxonomy_version,
             fact_set_hash, fact_types, status
           ) VALUES ($1, $2, $3, $4, $5, 'hash', '[]'::jsonb, 'EVALUATED')`,
          [
            mailbox.tenantId,
            persisted.conversation.id,
            persisted.message.id,
            CONVERSATION_POLICY_VERSION,
            CONVERSATION_POLICY_TAXONOMY_VERSION,
          ],
        );
        const evalRow = await tx.query<{ id: string }>("SELECT id FROM conversation_policy_evaluations LIMIT 1");
        await tx.query(
          `INSERT INTO conversation_policy_signals (
             tenant_id, conversation_id, policy_evaluation_id, source_message_id,
             signal, priority, source_fact_type, policy_version
           ) VALUES ($1, $2, $3, $4, 'CONTACT_SUPPRESSION_REQUIRED', 'CRITICAL', 'UNSUBSCRIBE', $5)`,
          [
            mailbox.tenantId,
            persisted.conversation.id,
            evalRow[0]?.id,
            persisted.message.id,
            CONVERSATION_POLICY_VERSION,
          ],
        );
        await insertIntegrationEvent(tx, sampleEnvelope(mailbox.tenantId, persisted.conversation.id, "key-1"));
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    const signals = await handle.database.query("SELECT id FROM conversation_policy_signals");
    const events = await handle.database.query("SELECT id FROM integration_events_outbox");
    expect(signals).toEqual([]);
    expect(events).toEqual([]);
  });

  it("enforces unique tenant + idempotency_key", async () => {
    const { conversationService, mailbox } = await setup();
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "int-uniq",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      textBody: "hi",
      sentAt: new Date(),
    });
    const first = await insertIntegrationEvent(
      handle.database,
      sampleEnvelope(mailbox.tenantId, persisted.conversation.id, "same-key"),
    );
    const second = await insertIntegrationEvent(
      handle.database,
      sampleEnvelope(mailbox.tenantId, persisted.conversation.id, "same-key"),
    );
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    const count = await handle.database.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM integration_events_outbox",
    );
    expect(count[0]?.n).toBe("1");
  });

  it("is safe under concurrent inserts of the same idempotency key", async () => {
    const { conversationService, mailbox } = await setup();
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "int-conc",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      textBody: "hi",
      sentAt: new Date(),
    });
    const results = await Promise.all([
      insertIntegrationEvent(handle.database, sampleEnvelope(mailbox.tenantId, persisted.conversation.id, "conc-key")),
      insertIntegrationEvent(handle.database, sampleEnvelope(mailbox.tenantId, persisted.conversation.id, "conc-key")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("isolates events by tenant", async () => {
    const first = await setup();
    const other = await new PostgresTenantRepository(handle.database).create({ name: "Other Integration" });
    const persisted = await first.conversationService.persistNormalized(first.mailbox.tenantId, first.mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "int-iso",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      textBody: "please unsubscribe",
      sentAt: new Date(),
    });
    await first.classificationWorker.runTick("c1");
    await first.policyWorker.runTick("p1");
    const repository = new PostgresIntegrationEventRepository(handle.database);
    const mine = await repository.list({ tenantId: first.tenant.id, limit: 10 });
    const theirs = await repository.list({ tenantId: other.id, limit: 10 });
    expect(mine).toHaveLength(1);
    expect(theirs).toEqual([]);
    expect(mine[0]?.conversationId).toBe(persisted.conversation.id);
  });

  it("keeps historical integration events when the policy version changes", async () => {
    const first = await setup("conversation-policy/v1");
    await first.conversationService.persistNormalized(first.mailbox.tenantId, first.mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "int-hist",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "out of office until Monday",
      sentAt: new Date(),
    });
    await first.classificationWorker.runTick("c1");
    await first.policyWorker.runTick("p1");
    const second = createConversationPolicyWorker({
      conversationService: first.conversationService,
      policyRepository: new PostgresConversationPolicyRepository(handle.database),
      policyVersion: "conversation-policy/v2",
      taxonomyVersion: CONVERSATION_POLICY_TAXONOMY_VERSION,
      auditRecorder: createFakeAuditEventRecorder(),
      logger,
    });
    await second.runTick("p2");
    const versions = await handle.database.query<{ policy_version: string; event_type: string }>(
      "SELECT policy_version, event_type FROM integration_events_outbox ORDER BY policy_version, event_type",
    );
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions.some((row) => row.policy_version === "conversation-policy/v1")).toBe(true);
    expect(versions.some((row) => row.policy_version === "conversation-policy/v2")).toBe(true);
  });
});

describe("message to integration event pipeline", () => {
  it("classifies, records facts and policy, then emits CONTACT_SUPPRESSION_REQUIRED without action events", async () => {
    const tenantRepository = new PostgresTenantRepository(handle.database);
    const credentialRepository = new PostgresApiCredentialRepository(handle.database);
    const auditRecorder = createPostgresAuditEventRecorder(handle.database, logger);
    const credentialService = createApiCredentialService({
      repository: credentialRepository,
      auditRecorder,
      pepper: testConfig.security.apiKeyPepper,
    });
    const tenant = await tenantRepository.create({ name: "Http Integration" });
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
      providerMessageId: "http-int",
      sender: "lead@example.com",
      recipients: ["p@skout.test"],
      textBody: "Interested, but please unsubscribe me.",
      sentAt: new Date(),
    });
    expect((await services.classificationWorker.runTick("http-c")).classified).toBe(1);
    expect((await services.policyWorker.runTick("http-p")).evaluated).toBe(1);

    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/integration-events" });
    expect(unauthenticated.statusCode).toBe(401);

    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/integration-events?eventType=CONTACT_SUPPRESSION_REQUIRED",
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().events).toHaveLength(1);
    expect(listed.json().events[0].eventType).toBe("CONTACT_SUPPRESSION_REQUIRED");
    expect(listed.json().events[0].conversationId).toBe(persisted.conversation.id);
    expect(listed.json().events[0].payload.contactIdentifier).toBe("lead@example.com");
    expect(JSON.stringify(listed.json())).not.toMatch(/Interested, but please unsubscribe/i);
    expect(JSON.stringify(listed.json())).not.toMatch(/STOP_SEQUENCE|CREATE_SUPPRESSION|SEND_FOLLOWUP|CREATE_CRM_TASK/);

    const cursor = listed.json().events[0].eventId as string;
    const nextPage = await app.inject({
      method: "GET",
      url: `/api/v1/integration-events?cursor=${cursor}`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(nextPage.statusCode).toBe(200);
    expect(nextPage.json().events).toEqual([]);

    const other = await tenantRepository.create({ name: "Other Http Integration" });
    const otherIssued = await credentialService.issueCredential(other.id, { name: "Other" });
    const isolated = await app.inject({
      method: "GET",
      url: "/api/v1/integration-events",
      headers: { authorization: `Bearer ${otherIssued.apiKey}` },
    });
    expect(isolated.json().events).toEqual([]);

    const tables = await handle.database.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relkind = 'r' AND relname LIKE '%suppression%'`,
    );
    expect(tables).toEqual([]);
    expect(listed.json().hasMore).toBe(false);
    expect(listed.json().events[0].schemaVersion).toBe(1);
    expect(listed.json().events[0].entityType).toBe("conversation");
    expect(listed.json().events[0].entityId).toBe(persisted.conversation.id);
    expect(listed.json().events[0].mailboxId).toBe(mailboxId);
    expect(listed.json().events[0].source).toBe("conversation-intelligence");
    expect(listed.json().events[0].createdAt).toEqual(expect.any(String));
    expect(listed.json().contractVersion).toBe("conversation-integration/v1");
    expect(listed.headers["x-integration-contract-version"]).toBe("conversation-integration/v1");
    await app.close();
  });
});

describe("Stage 16 consumption contract", () => {
  async function seedConversation() {
    const { conversationService, mailbox, tenant } = await setup();
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: `consume-${randomUUID()}`,
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "hello",
      sentAt: new Date(),
    });
    return { tenant, mailbox, conversationId: persisted.conversation.id };
  }

  async function insertEvents(
    tenantId: string,
    conversationId: string,
    count: number,
    occurredAtForIndex?: (index: number) => string,
  ) {
    for (let index = 0; index < count; index += 1) {
      const eventId = randomUUID();
      await insertIntegrationEvent(
        handle.database,
        sampleEnvelope(tenantId, conversationId, `consume-key-${randomUUID()}`, eventId, {
          ...(occurredAtForIndex ? { occurredAt: occurredAtForIndex(index) } : {}),
        }),
      );
    }
    const ordered = await handle.database.query<{ event_id: string }>(
      `SELECT event_id FROM integration_events_outbox
       WHERE tenant_id = $1
       ORDER BY created_at ASC, event_id ASC`,
      [tenantId],
    );
    return { orderedIds: ordered.map((row) => row.event_id) };
  }

  it("paginates with a stable cursor, deterministic order, and continuation token", async () => {
    const { tenant, conversationId } = await seedConversation();
    const { orderedIds } = await insertEvents(tenant.id, conversationId, 5, (index) =>
      new Date(Date.UTC(2020, 0, 1 + index)).toISOString(),
    );
    const credentialService = createApiCredentialService({
      repository: new PostgresApiCredentialRepository(handle.database),
      auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
      pepper: testConfig.security.apiKeyPepper,
    });
    const issued = await credentialService.issueCredential(tenant.id, { name: "Consume" });
    const app = await buildApp(testConfig, logger, handle.database, redis);

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/integration-events?limit=2",
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().events.map((row: { eventId: string }) => row.eventId)).toEqual(orderedIds.slice(0, 2));
    expect(first.json().hasMore).toBe(true);
    expect(first.json().nextCursor).toBe(orderedIds[1]);

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/integration-events?limit=2&cursor=${first.json().nextCursor}`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(second.json().events.map((row: { eventId: string }) => row.eventId)).toEqual(orderedIds.slice(2, 4));
    expect(second.json().hasMore).toBe(true);

    const third = await app.inject({
      method: "GET",
      url: `/api/v1/integration-events?limit=2&cursor=${second.json().nextCursor}`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    expect(third.json().events.map((row: { eventId: string }) => row.eventId)).toEqual(orderedIds.slice(4));
    expect(third.json().hasMore).toBe(false);
    expect(third.json().nextCursor).toBeUndefined();

    const concatenated = [
      ...first.json().events,
      ...second.json().events,
      ...third.json().events,
    ].map((row: { eventId: string }) => row.eventId);
    expect(concatenated).toEqual(orderedIds);
    expect(new Set(concatenated).size).toBe(orderedIds.length);

    await insertIntegrationEvent(
      handle.database,
      sampleEnvelope(tenant.id, conversationId, `late-${randomUUID()}`, randomUUID(), {
        occurredAt: "2010-01-01T00:00:00.000Z",
      }),
    );
    const afterInsert = await app.inject({
      method: "GET",
      url: `/api/v1/integration-events?limit=2&cursor=${first.json().nextCursor}`,
      headers: { authorization: `Bearer ${issued.apiKey}` },
    });
    const afterIds = afterInsert.json().events.map((row: { eventId: string }) => row.eventId) as string[];
    expect(afterIds).not.toEqual(expect.arrayContaining(orderedIds.slice(0, 2)));
    expect(afterIds[0]).toBe(orderedIds[2]);
    await app.close();
  });

  it("is at-least-once: concurrent pulls and duplicate cursor reads return the same event_id", async () => {
    const { tenant, conversationId } = await seedConversation();
    const { orderedIds } = await insertEvents(tenant.id, conversationId, 3);
    const credentialService = createApiCredentialService({
      repository: new PostgresApiCredentialRepository(handle.database),
      auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
      pepper: testConfig.security.apiKeyPepper,
    });
    const issued = await credentialService.issueCredential(tenant.id, { name: "Dedupe" });
    const app = await buildApp(testConfig, logger, handle.database, redis);
    const headers = { authorization: `Bearer ${issued.apiKey}` };

    const [a, b] = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/integration-events?limit=10", headers }),
      app.inject({ method: "GET", url: "/api/v1/integration-events?limit=10", headers }),
    ]);
    expect(a.json().events.map((row: { eventId: string }) => row.eventId)).toEqual(orderedIds);
    expect(b.json().events.map((row: { eventId: string }) => row.eventId)).toEqual(orderedIds);

    const page = await app.inject({ method: "GET", url: "/api/v1/integration-events?limit=1", headers });
    const cursor = page.json().nextCursor as string;
    const firstDup = await app.inject({
      method: "GET",
      url: `/api/v1/integration-events?limit=10&cursor=${cursor}`,
      headers,
    });
    const secondDup = await app.inject({
      method: "GET",
      url: `/api/v1/integration-events?limit=10&cursor=${cursor}`,
      headers,
    });
    expect(firstDup.json().events.map((row: { eventId: string }) => row.eventId)).toEqual(orderedIds.slice(1));
    expect(secondDup.json().events.map((row: { eventId: string }) => row.eventId)).toEqual(
      firstDup.json().events.map((row: { eventId: string }) => row.eventId),
    );

    const statuses = await handle.database.query<{ status: string; event_id: string }>(
      "SELECT status, event_id FROM integration_events_outbox WHERE tenant_id = $1",
      [tenant.id],
    );
    expect(statuses.every((row) => row.status === "RECORDED")).toBe(true);
    expect(new Set(statuses.map((row) => row.event_id)).size).toBe(3);
    await app.close();
  });

  it("isolates tenants, rejects foreign/invalid cursors, and enforces page size", async () => {
    const first = await seedConversation();
    const second = await seedConversation();
    const { orderedIds } = await insertEvents(first.tenant.id, first.conversationId, 2);
    await insertEvents(second.tenant.id, second.conversationId, 2);

    const credentialService = createApiCredentialService({
      repository: new PostgresApiCredentialRepository(handle.database),
      auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
      pepper: testConfig.security.apiKeyPepper,
    });
    const firstKey = await credentialService.issueCredential(first.tenant.id, { name: "T1" });
    const secondKey = await credentialService.issueCredential(second.tenant.id, { name: "T2" });
    const app = await buildApp(testConfig, logger, handle.database, redis);

    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/integration-events",
      headers: { authorization: `Bearer ${firstKey.apiKey}` },
    });
    expect(mine.json().events.map((row: { eventId: string }) => row.eventId)).toEqual(orderedIds);

    const foreignCursor = await app.inject({
      method: "GET",
      url: `/api/v1/integration-events?cursor=${orderedIds[0]}`,
      headers: { authorization: `Bearer ${secondKey.apiKey}` },
    });
    expect(foreignCursor.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "GET",
      url: `/api/v1/integration-events?cursor=${randomUUID()}`,
      headers: { authorization: `Bearer ${firstKey.apiKey}` },
    });
    expect(unknown.statusCode).toBe(400);

    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/integration-events?cursor=not-a-cursor",
      headers: { authorization: `Bearer ${firstKey.apiKey}` },
    });
    expect(malformed.statusCode).toBe(400);

    const tooBig = await app.inject({
      method: "GET",
      url: "/api/v1/integration-events?limit=101",
      headers: { authorization: `Bearer ${firstKey.apiKey}` },
    });
    expect(tooBig.statusCode).toBe(400);

    const tooSmall = await app.inject({
      method: "GET",
      url: "/api/v1/integration-events?limit=0",
      headers: { authorization: `Bearer ${firstKey.apiKey}` },
    });
    expect(tooSmall.statusCode).toBe(400);

    const invalidKey = await app.inject({
      method: "GET",
      url: "/api/v1/integration-events",
      headers: { authorization: "Bearer sk_invalid_not_a_real_key" },
    });
    expect(invalidKey.statusCode).toBe(401);
    await app.close();
  });

  it("keeps event_id and historical payloads stable across reads", async () => {
    const { tenant, mailbox, conversationId } = await seedConversation();
    const eventId = randomUUID();
    await insertIntegrationEvent(
      handle.database,
      sampleEnvelope(tenant.id, conversationId, `hist-${eventId}`, eventId, {
        eventVersion: 1,
        payloadExtra: { legacyNote: "do-not-transform" },
      }),
    );
    const credentialService = createApiCredentialService({
      repository: new PostgresApiCredentialRepository(handle.database),
      auditRecorder: createPostgresAuditEventRecorder(handle.database, logger),
      pepper: testConfig.security.apiKeyPepper,
    });
    const issued = await credentialService.issueCredential(tenant.id, { name: "Hist" });
    const app = await buildApp(testConfig, logger, handle.database, redis);
    const headers = { authorization: `Bearer ${issued.apiKey}` };

    const first = await app.inject({ method: "GET", url: "/api/v1/integration-events", headers });
    const second = await app.inject({ method: "GET", url: "/api/v1/integration-events", headers });
    expect(first.json().events[0].eventId).toBe(eventId);
    expect(second.json().events[0].eventId).toBe(eventId);
    expect(first.json().events[0].schemaVersion).toBe(1);
    expect(first.json().events[0].payload.legacyNote).toBe("do-not-transform");
    expect(second.json().events[0].payload).toEqual(first.json().events[0].payload);
    expect(first.json().events[0].mailboxId).toBe(mailbox.id);
    expect(first.json().events[0].source).toBe(INTEGRATION_EVENT_SOURCE);
    expect(first.json().events[0].createdAt).toEqual(expect.any(String));
    expect(JSON.stringify(first.json().events[0].payload)).not.toMatch(/mailboxId/);

    const row = await handle.database.query<{ id: string; event_id: string }>(
      "SELECT id, event_id FROM integration_events_outbox WHERE event_id = $1",
      [eventId],
    );
    expect(row[0]?.event_id).toBe(eventId);
    expect(row[0]?.id).not.toBe(eventId);
    await app.close();
  });

  it("rejects updates and deletes of outbox rows", async () => {
    const { tenant, conversationId } = await seedConversation();
    const eventId = randomUUID();
    await insertIntegrationEvent(
      handle.database,
      sampleEnvelope(tenant.id, conversationId, `imm-${eventId}`, eventId),
    );
    await expect(
      handle.pool.query("UPDATE integration_events_outbox SET payload = '{}'::jsonb WHERE event_id = $1", [eventId]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      handle.pool.query("DELETE FROM integration_events_outbox WHERE event_id = $1", [eventId]),
    ).rejects.toThrow(/immutable/i);
    const remaining = await handle.database.query<{ event_id: string; payload: { legacyNote?: string } }>(
      "SELECT event_id, payload FROM integration_events_outbox WHERE event_id = $1",
      [eventId],
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.event_id).toBe(eventId);
  });
});
