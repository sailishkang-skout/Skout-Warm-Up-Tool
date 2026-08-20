import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInboundSyncService } from "../../src/modules/conversations/application/inbound-sync-service.js";
import { createConversationService } from "../../src/modules/conversations/application/conversation-service.js";
import { PostgresConversationMessageRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-message-repository.js";
import { PostgresConversationRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-repository.js";
import { PostgresInboundSyncStateRepository } from "../../src/modules/conversations/infrastructure/postgres-inbound-sync-state-repository.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { HistoryCursorInvalidError } from "../../src/modules/conversations/domain/normalized-inbound.js";
import type { InboundMessageProvider } from "../../src/modules/conversations/application/inbound-message-provider.js";
import type { NormalizedInbound } from "../../src/modules/conversations/domain/normalized-inbound.js";
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

function fakeInbound(messages: NormalizedInbound[], nextCursor = "cursor-2"): InboundMessageProvider {
  return {
    async listChanges() {
      return { messages, nextCursor };
    },
    async getMessage() {
      return messages[0] ?? null;
    },
  };
}

describe("inbound sync", () => {
  async function setup(provider: InboundMessageProvider) {
    const auditRecorder = createFakeAuditEventRecorder();
    const registry = createProviderRegistry();
    registry.register(new GmailAdapter());
    const credentialStore = createInMemoryProviderCredentialStore({ isProduction: false });
    const mailboxService = createMailboxService({
      database: handle.database,
      mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
      providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
      providerRegistry: registry,
      credentialStore,
      auditRecorder,
    });
    const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Sync Co" });
    const mailbox = await new PostgresMailboxRepository(handle.database).create({
      tenantId: tenant.id,
      emailAddress: "sync@skout.test",
      provider: "GMAIL",
      status: "CONNECTED",
    });
    const account = await new PostgresProviderAccountRepository(handle.database).create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "GMAIL",
      status: "ACTIVE",
    });
    await credentialStore.saveCredential({
      providerAccountId: account.id,
      kind: "GOOGLE_OAUTH",
      secretData: { accessToken: "tok" },
    });
    const conversationService = createConversationService({
      database: handle.database,
      mailboxService,
      conversationRepository: new PostgresConversationRepository(handle.database),
      messageRepository: new PostgresConversationMessageRepository(handle.database),
      auditRecorder,
    });
    const syncStateRepository = new PostgresInboundSyncStateRepository(handle.database);
    const inboundSyncService = createInboundSyncService({
      database: handle.database,
      mailboxService,
      providerRegistry: registry,
      providerAccountRepository: new PostgresProviderAccountRepository(handle.database),
      credentialStore,
      auditRecorder,
      conversationService,
      syncStateRepository,
      listPollableMailboxes: async () => [{ tenantId: tenant.id, mailboxId: mailbox.id, provider: "GMAIL" }],
      inboundProviders: { GMAIL: provider, MICROSOFT365: provider },
      logger,
    });
    return { inboundSyncService, conversationService, mailbox, tenant, auditRecorder, syncStateRepository };
  }

  it("persists messages and advances the cursor only after commit", async () => {
    const message: NormalizedInbound = {
      provider: "GMAIL",
      direction: "INBOUND",
      providerMessageId: "sync-1",
      sender: "a@b.com",
      recipients: ["sync@skout.test"],
      sentAt: new Date(),
    };
    const { inboundSyncService, mailbox, auditRecorder } = await setup(fakeInbound([message], "hist-2"));
    const result = await inboundSyncService.runTick("worker-1");
    expect(result.messagesInserted).toBe(1);
    const state = await handle.database.query<{ cursor: string | null }>(
      "SELECT cursor FROM mailbox_inbound_sync_state WHERE mailbox_id = $1",
      [mailbox.id],
    );
    expect(state[0]?.cursor).toBe("hist-2");
    expect(auditRecorder.events.filter((event) => event.eventType === "MESSAGE_RECEIVED")).toHaveLength(1);

    const duplicate = await inboundSyncService.runTick("worker-1");
    expect(duplicate.messagesInserted).toBe(0);
    expect(auditRecorder.events.filter((event) => event.eventType === "MESSAGE_RECEIVED")).toHaveLength(1);
  });

  it("does not advance the cursor when the provider reports an invalid history id", async () => {
    const failing: InboundMessageProvider = {
      async listChanges() {
        throw new HistoryCursorInvalidError("GMAIL", "Gmail history cursor is no longer valid; explicit resync required.");
      },
      async getMessage() {
        return null;
      },
    };
    const { inboundSyncService, mailbox } = await setup(failing);
    await inboundSyncService.runTick("worker-1");
    const state = await handle.database.query<{ cursor: string | null; last_error_safe: string | null }>(
      "SELECT cursor, last_error_safe FROM mailbox_inbound_sync_state WHERE mailbox_id = $1",
      [mailbox.id],
    );
    expect(state[0]?.cursor).toBeNull();
    expect(state[0]?.last_error_safe).toMatch(/resync required/);
  });

  it("reclaims expired inbound leases", async () => {
    const { inboundSyncService, mailbox, syncStateRepository } = await setup(fakeInbound([]));
    await syncStateRepository.ensure(mailbox.tenantId, mailbox.id, "GMAIL");
    await handle.database.query(
      `UPDATE mailbox_inbound_sync_state SET lease_owner = 'dead', lease_expires_at = now() - interval '1 minute' WHERE mailbox_id = $1`,
      [mailbox.id],
    );
    const result = await inboundSyncService.runTick("worker-live");
    expect(result.reclaimedLeases).toBe(1);
  });
});
