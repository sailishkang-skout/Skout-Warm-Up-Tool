import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConversationService } from "../../src/modules/conversations/application/conversation-service.js";
import { PostgresConversationMessageRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-message-repository.js";
import { PostgresConversationRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-repository.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { TEXT_BODY_MAX_BYTES } from "../../src/modules/conversations/domain/conversation-message.js";
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
import type { NormalizedInbound } from "../../src/modules/conversations/domain/normalized-inbound.js";

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

function services() {
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
  const conversationService = createConversationService({
    database: handle.database,
    mailboxService,
    conversationRepository: new PostgresConversationRepository(handle.database),
    messageRepository: new PostgresConversationMessageRepository(handle.database),
    auditRecorder,
  });
  return { conversationService, mailboxService, auditRecorder };
}

async function fixture() {
  const { conversationService, mailboxService, auditRecorder } = services();
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Conv Co" });
  const mailbox = await mailboxService.createMailbox(tenant.id, { emailAddress: "me@skout.test", provider: "GMAIL" });
  return { conversationService, mailboxService, auditRecorder, tenant, mailbox };
}

function inbound(overrides: Partial<NormalizedInbound> = {}): NormalizedInbound {
  return {
    provider: "GMAIL",
    direction: "INBOUND",
    providerMessageId: "m-in",
    providerThreadId: "thread-1",
    rfcMessageId: "<in@example.com>",
    sender: "ada@example.com",
    recipients: ["me@skout.test"],
    subject: "Hello",
    textBody: "hi",
    sentAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("conversation persistence", () => {
  it("creates a conversation and message, keeping html_body null", async () => {
    const { conversationService, mailbox, auditRecorder } = await fixture();
    const result = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, inbound());
    expect(result.conversationCreated).toBe(true);
    expect(result.messageInserted).toBe(true);
    expect(result.conversation.state).toBe("REPLIED");
    const rows = await handle.database.query<{ html_body: string | null }>("SELECT html_body FROM conversation_messages");
    expect(rows[0]?.html_body).toBeNull();
    expect(auditRecorder.events.map((event) => event.eventType)).toEqual([
      "MAILBOX_CREATED",
      "CONVERSATION_CREATED",
      "MESSAGE_RECEIVED",
    ]);
    expect(JSON.stringify(auditRecorder.events)).not.toContain("hi");
  });

  it("deduplicates provider message ids and does not emit a second MESSAGE_RECEIVED", async () => {
    const { conversationService, mailbox, auditRecorder } = await fixture();
    await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, inbound());
    auditRecorder.events.length = 0;
    const second = await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, inbound({ textBody: "changed" }));
    expect(second.messageInserted).toBe(false);
    expect(auditRecorder.events).toEqual([]);
  });

  it("deduplicates RFC Message-ID", async () => {
    const { conversationService, mailbox } = await fixture();
    await conversationService.persistNormalized(mailbox.tenantId, mailbox.id, inbound({ providerMessageId: "a" }));
    const second = await conversationService.persistNormalized(
      mailbox.tenantId,
      mailbox.id,
      inbound({ providerMessageId: "b", rfcMessageId: "<in@example.com>" }),
    );
    expect(second.messageInserted).toBe(false);
  });

  it("truncates oversized text bodies", async () => {
    const { conversationService, mailbox } = await fixture();
    const result = await conversationService.persistNormalized(
      mailbox.tenantId,
      mailbox.id,
      inbound({ textBody: "x".repeat(TEXT_BODY_MAX_BYTES + 20) }),
    );
    expect(Buffer.byteLength(result.message.textBody ?? "", "utf8")).toBe(TEXT_BODY_MAX_BYTES);
  });

  it("isolates tenants", async () => {
    const first = await fixture();
    const secondTenant = await new PostgresTenantRepository(handle.database).create({ name: "Other" });
    await first.conversationService.persistNormalized(first.mailbox.tenantId, first.mailbox.id, inbound());
    await expect(first.conversationService.listConversations(secondTenant.id, first.mailbox.id, 10, 0)).rejects.toThrow();
  });

  it("survives concurrent duplicate inserts", async () => {
    const { conversationService, mailbox } = await fixture();
    const message = inbound({ providerMessageId: "same" });
    const [a, b] = await Promise.all([
      conversationService.persistNormalized(mailbox.tenantId, mailbox.id, message),
      conversationService.persistNormalized(mailbox.tenantId, mailbox.id, message),
    ]);
    expect([a.messageInserted, b.messageInserted].filter(Boolean)).toHaveLength(1);
    const count = await handle.database.query<{ n: string }>("SELECT count(*)::text AS n FROM conversation_messages");
    expect(count[0]?.n).toBe("1");
  });
});
