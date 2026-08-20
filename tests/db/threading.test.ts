import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConversationService } from "../../src/modules/conversations/application/conversation-service.js";
import { PostgresConversationMessageRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-message-repository.js";
import { PostgresConversationRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-repository.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { Microsoft365Adapter } from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
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

const logger = createLogger({ level: "silent", serviceName: "skout-email-warmup-service-tests", env: "test" });
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

describe("threading", () => {
  it("groups Gmail messages that share a threadId into one conversation", async () => {
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
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Thread Co" });
    const mailbox = await mailboxService.createMailbox(tenant.id, { emailAddress: "thread@skout.test", provider: "GMAIL" });
    const conversationService = createConversationService({
      database: handle.database,
      mailboxService,
      conversationRepository: new PostgresConversationRepository(handle.database),
      messageRepository: new PostgresConversationMessageRepository(handle.database),
      auditRecorder,
    });
    const first = await conversationService.persistNormalized(tenant.id, mailbox.id, {
      provider: "GMAIL",
      direction: "OUTBOUND",
      providerMessageId: "g1",
      providerThreadId: "thread-abc",
      sender: "thread@skout.test",
      recipients: ["thread@skout.test"],
      sentAt: new Date("2026-01-01T00:00:00Z"),
    });
    const second = await conversationService.persistNormalized(tenant.id, mailbox.id, {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "g2",
      providerThreadId: "thread-abc",
      inReplyTo: "<g1@mail>",
      sender: "other@example.com",
      recipients: ["thread@skout.test"],
      sentAt: new Date("2026-01-01T00:05:00Z"),
    });
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.conversationCreated).toBe(false);
    expect(second.conversation.state).toBe("REPLIED");
  });

  it("groups Graph messages by conversationId and keeps missing conversationId unthreaded", async () => {
    const auditRecorder = createFakeAuditEventRecorder();
    const registry = createProviderRegistry();
    registry.register(new Microsoft365Adapter());
    const mailboxService = createMailboxService({
      database: handle.database,
      mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
      providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
      providerRegistry: registry,
      credentialStore: createInMemoryProviderCredentialStore({ isProduction: false }),
      auditRecorder,
    });
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Graph Thread Co" });
    const mailbox = await mailboxService.createMailbox(tenant.id, {
      emailAddress: "graph@skout.test",
      provider: "MICROSOFT365",
    });
    const conversationService = createConversationService({
      database: handle.database,
      mailboxService,
      conversationRepository: new PostgresConversationRepository(handle.database),
      messageRepository: new PostgresConversationMessageRepository(handle.database),
      auditRecorder,
    });
    const first = await conversationService.persistNormalized(tenant.id, mailbox.id, {
      provider: "MICROSOFT365",
      direction: "INBOUND",
      providerMessageId: "n1",
      providerThreadId: "conv-1",
      sender: "a@contoso.com",
      recipients: ["graph@skout.test"],
      sentAt: new Date(),
    });
    const second = await conversationService.persistNormalized(tenant.id, mailbox.id, {
      provider: "MICROSOFT365",
      direction: "INBOUND",
      providerMessageId: "n2",
      providerThreadId: "conv-1",
      sender: "a@contoso.com",
      recipients: ["graph@skout.test"],
      sentAt: new Date(),
    });
    const orphan = await conversationService.persistNormalized(tenant.id, mailbox.id, {
      provider: "MICROSOFT365",
      direction: "INBOUND",
      providerMessageId: "n3",
      sender: "b@contoso.com",
      recipients: ["graph@skout.test"],
      sentAt: new Date(),
    });
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(orphan.conversation.id).not.toBe(first.conversation.id);
  });
});
