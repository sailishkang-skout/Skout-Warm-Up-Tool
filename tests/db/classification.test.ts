import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConversationService } from "../../src/modules/conversations/application/conversation-service.js";
import { createClassificationWorker } from "../../src/modules/conversations/application/classification-worker.js";
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
import { TransientError } from "../../src/shared/errors/index.js";
import { runMigrations } from "../../src/shared/db/index.js";
import { createLogger } from "../../src/shared/logger/index.js";
import { createFakeAuditEventRecorder } from "../support/fake-audit-event-recorder.js";
import {
  createTestDatabaseHandle,
  ensureTestDatabaseExists,
  resetSchema,
  truncateAppTables,
  type TestDatabaseHandle,
} from "./support.js";
import type { ConversationClassifier } from "../../src/modules/conversations/application/conversation-classifier.js";

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
const CLASSIFIER_VERSION = "conversation-classifier/v1";
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

function fakeClassifier(result = {
  labels: ["INTERESTED", "MEETING_REQUEST"] as const,
  primaryLabel: "INTERESTED" as const,
  confidence: 0.9,
  confidenceBand: "HIGH" as const,
  reason: "Asked for a meeting",
}): ConversationClassifier {
  return {
    async classify() {
      return result;
    },
  };
}

async function setup(classifier: ConversationClassifier = fakeClassifier()) {
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
  });
  const worker = createClassificationWorker({
    conversationService,
    messageRepository,
    classificationRepository,
    classifier,
    classifierVersion: CLASSIFIER_VERSION,
    modelName: "test-model",
    maxInputChars: 4000,
    auditRecorder,
    logger,
  });
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Class Co" });
  const mailbox = await mailboxService.createMailbox(tenant.id, { emailAddress: "me@skout.test", provider: "GMAIL" });
  return { conversationService, worker, mailbox, tenant, auditRecorder, classificationRepository };
}

describe("classification persistence and worker", () => {
  it("enqueues, classifies, projects facts, and audits once", async () => {
    const { conversationService, worker, mailbox, auditRecorder } = await setup();
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "c1",
      sender: "lead@example.com",
      recipients: ["me@skout.test"],
      textBody: "Can we book a demo?",
      sentAt: new Date(),
    });
    const first = await worker.runTick("w1");
    expect(first.classified).toBe(1);
    const second = await worker.runTick("w1");
    expect(second.classified).toBe(0);
    expect(auditRecorder.events.filter((event) => event.eventType === "MESSAGE_CLASSIFIED")).toHaveLength(1);
    expect(auditRecorder.events.filter((event) => event.eventType === "CONVERSATION_CLASSIFIED")).toHaveLength(1);
    expect(JSON.stringify(auditRecorder.events)).not.toContain("book a demo");
    const facts = await worker.getConversationFacts(mailbox.tenantId, persisted.conversation.id);
    expect(facts?.labels).toEqual(["INTERESTED", "MEETING_REQUEST"]);
    expect(facts?.needsHumanReview).toBe(false);
  });

  it("isolates tenants", async () => {
    const first = await setup();
    const other = await new PostgresTenantRepository(handle.database).create({ name: "Other" });
    const persisted = await first.conversationService.persistNormalized(first.mailbox.tenantId, first.mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "iso",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      sentAt: new Date(),
    });
    await first.worker.runTick("w1");
    await expect(first.worker.getMessageClassification(other.id, persisted.conversation.id, persisted.message.id)).rejects.toThrow();
  });

  it("is idempotent under concurrent workers", async () => {
    const { conversationService, worker, mailbox } = await setup();
    await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "conc",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      sentAt: new Date(),
    });
    const [a, b] = await Promise.all([worker.runTick("wa"), worker.runTick("wb")]);
    expect(a.classified + b.classified).toBe(1);
    const count = await handle.database.query<{ n: string }>("SELECT count(*)::text AS n FROM conversation_message_classifications");
    expect(count[0]?.n).toBe("1");
  });

  it("retries a transient failure then classifies", async () => {
    let calls = 0;
    const classifier: ConversationClassifier = {
      async classify() {
        calls += 1;
        if (calls === 1) {
          throw new TransientError("model timeout");
        }
        return {
          labels: ["NEUTRAL"],
          primaryLabel: "NEUTRAL",
          confidence: 0.4,
          confidenceBand: "LOW",
          reason: "unclear",
        };
      },
    };
    const { conversationService, worker, mailbox } = await setup(classifier);
    await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "retry",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      sentAt: new Date(),
    });
    const first = await worker.runTick("w1");
    expect(first.classified).toBe(0);
    await handle.database.query("UPDATE conversation_message_classifications SET next_attempt_at = now() - interval '1 second'");
    const second = await worker.runTick("w1");
    expect(second.classified).toBe(1);
  });

  it("reclaims an expired processing lease", async () => {
    const { conversationService, worker, mailbox, classificationRepository } = await setup();
    const persisted = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "lease",
      sender: "a@b.com",
      recipients: ["me@skout.test"],
      sentAt: new Date(),
    });
    await handle.database.query(
      `UPDATE conversation_message_classifications
       SET status = 'PROCESSING', lease_owner = 'dead', lease_expires_at = now() - interval '1 minute'
       WHERE message_id = $1`,
      [persisted.message.id],
    );
    const result = await worker.runTick("live");
    expect(result.reclaimedLeases).toBe(1);
    expect(result.classified).toBe(1);
    expect(classificationRepository).toBeTruthy();
  });
});
