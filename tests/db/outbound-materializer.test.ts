import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConversationService } from "../../src/modules/conversations/application/conversation-service.js";
import { createOutboundMaterializer } from "../../src/modules/conversations/application/outbound-materializer.js";
import { PostgresConversationMessageRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-message-repository.js";
import { PostgresConversationRepository } from "../../src/modules/conversations/infrastructure/postgres-conversation-repository.js";
import { createUnmaterializedSentIntentReader } from "../../src/modules/conversations/infrastructure/unmaterialized-sent-intent-reader.js";
import { createMailboxService } from "../../src/modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../../src/modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { PostgresProviderAccountRepository } from "../../src/modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createProviderRegistry } from "../../src/modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../../src/modules/providers/infrastructure/gmail/gmail-adapter.js";
import { Microsoft365Adapter } from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { GmailInboundProvider } from "../../src/modules/providers/infrastructure/gmail/gmail-inbound-provider.js";
import { Microsoft365InboundProvider } from "../../src/modules/providers/infrastructure/microsoft365/microsoft365-inbound-provider.js";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { PostgresTenantRepository } from "../../src/modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { PostgresWarmupDecisionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../../src/modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import { computeIdempotencyKey } from "../../src/modules/warmup/domain/warmup-execution-intent.js";
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

async function createSentIntent(provider: "GMAIL" | "MICROSOFT365", lastResult: Record<string, unknown>) {
  const tenant = await new PostgresTenantRepository(handle.database).create({ name: "Mat Co" });
  const mailbox = await new PostgresMailboxRepository(handle.database).create({
    tenantId: tenant.id,
    emailAddress: "mat@skout.test",
    provider,
    status: "CONNECTED",
  });
  const profile = await new PostgresWarmupProfileRepository(handle.database).create({
    tenantId: tenant.id,
    mailboxId: mailbox.id,
    targetDailyVolume: 30,
    startingDailyVolume: 5,
    maximumDailyVolume: 50,
    rampStrategy: "STANDARD",
    riskTolerance: "MEDIUM",
  });
  const session = await new PostgresWarmupSessionRepository(handle.database).create({
    tenantId: tenant.id,
    mailboxId: mailbox.id,
    profileId: profile.id,
  });
  const decision = await new PostgresWarmupDecisionRepository(handle.database).create({
    tenantId: tenant.id,
    sessionId: session.id,
    mailboxId: mailbox.id,
    warmupDay: 1,
    decision: "PROCEED",
    reasonCodes: ["RAMP_PROGRESSION"],
    reasons: ["ok"],
    recommendedVolume: 5,
    maximumVolume: 50,
    riskLevel: "LOW",
    eligibility: "ELIGIBLE",
    profileSnapshot: {
      targetDailyVolume: 30,
      startingDailyVolume: 5,
      maximumDailyVolume: 50,
      rampStrategy: "STANDARD",
      riskTolerance: "MEDIUM",
      active: true,
      pauseConditions: [],
    },
    generatedAt: new Date(),
  });
  const intentRepository = new PostgresWarmupExecutionIntentRepository(handle.database);
  const intent = await intentRepository.createIfAbsent({
    tenantId: tenant.id,
    sessionId: session.id,
    mailboxId: mailbox.id,
    decisionId: decision.id,
    provider,
    warmupDay: 1,
    executionSlot: 0,
    idempotencyKey: computeIdempotencyKey({ tenantId: tenant.id, sessionId: session.id, warmupDay: 1, executionSlot: 0 }),
    volume: 5,
    expiresAt: new Date(Date.now() + 60_000),
  });
  await handle.database.query(
    `UPDATE warmup_execution_intents SET status = 'SENT', last_result = $2::jsonb WHERE id = $1`,
    [intent.id, JSON.stringify(lastResult)],
  );
  return { tenant, mailbox, intent };
}

describe("outbound materializer", () => {
  it("materializes a Gmail sent intent from providerMessageId via messages.get", async () => {
    const sentAt = new Date("2026-01-01T00:00:00.000Z");
    const { tenant, mailbox, intent } = await createSentIntent("GMAIL", {
      status: "ACCEPTED",
      provider: "GMAIL",
      providerMessageId: "gmail-sent-1",
      timestamp: sentAt.toISOString(),
      retryable: false,
    });
    const fetched: NormalizedInbound = {
      provider: "GMAIL",
      direction: "OUTBOUND",
      providerMessageId: "gmail-sent-1",
      providerThreadId: "th-sent",
      rfcMessageId: "<sent@gmail>",
      sender: "mat@skout.test",
      recipients: ["mat@skout.test"],
      subject: "Warmup",
      textBody: "check-in",
      sentAt,
    };
    const gmail: GmailInboundProvider = Object.assign(new GmailInboundProvider(), {
      getMessage: async () => fetched,
    });
    const graph = new Microsoft365InboundProvider();
    const auditRecorder = createFakeAuditEventRecorder();
    const registry = createProviderRegistry();
    registry.register(new GmailAdapter());
    registry.register(new Microsoft365Adapter());
    const credentialStore = createInMemoryProviderCredentialStore({ isProduction: false });
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
    const mailboxService = createMailboxService({
      database: handle.database,
      mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
      providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
      providerRegistry: registry,
      credentialStore,
      auditRecorder,
    });
    const messageRepository = new PostgresConversationMessageRepository(handle.database);
    const conversationService = createConversationService({
      database: handle.database,
      mailboxService,
      conversationRepository: new PostgresConversationRepository(handle.database),
      messageRepository,
      auditRecorder,
    });
    const materializer = createOutboundMaterializer({
      mailboxService,
      providerRegistry: registry,
      providerAccountRepository: new PostgresProviderAccountRepository(handle.database),
      credentialStore,
      auditRecorder,
      conversationService,
      messageRepository,
      inboundProviders: { GMAIL: gmail, MICROSOFT365: graph },
      graphInboundProvider: graph,
      listUnmaterialized: (limit) => createUnmaterializedSentIntentReader(handle.database).list(limit),
      logger,
    });
    const result = await materializer.runTick();
    expect(result.materialized).toBe(1);
    const linked = await messageRepository.findByExecutionIntentId(tenant.id, intent.id);
    expect(linked?.providerMessageId).toBe("gmail-sent-1");
    expect(auditRecorder.events.map((event) => event.eventType)).toContain("MESSAGE_SENT");
  });

  it("leaves a Graph 202 send unmatched when Sent Items has no conservative match", async () => {
    const { tenant, mailbox } = await createSentIntent("MICROSOFT365", {
      status: "ACCEPTED",
      provider: "MICROSOFT365",
      timestamp: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      retryable: false,
    });
    const graph = Object.assign(new Microsoft365InboundProvider(), {
      listRecentSent: async () => [],
    });
    const auditRecorder = createFakeAuditEventRecorder();
    const registry = createProviderRegistry();
    registry.register(new Microsoft365Adapter());
    const credentialStore = createInMemoryProviderCredentialStore({ isProduction: false });
    const account = await new PostgresProviderAccountRepository(handle.database).create({
      tenantId: tenant.id,
      mailboxId: mailbox.id,
      provider: "MICROSOFT365",
      status: "ACTIVE",
    });
    await credentialStore.saveCredential({
      providerAccountId: account.id,
      kind: "MICROSOFT_OAUTH",
      secretData: { accessToken: "tok" },
    });
    const mailboxService = createMailboxService({
      database: handle.database,
      mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
      providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
      providerRegistry: registry,
      credentialStore,
      auditRecorder,
    });
    const messageRepository = new PostgresConversationMessageRepository(handle.database);
    const conversationService = createConversationService({
      database: handle.database,
      mailboxService,
      conversationRepository: new PostgresConversationRepository(handle.database),
      messageRepository,
      auditRecorder,
    });
    const materializer = createOutboundMaterializer({
      mailboxService,
      providerRegistry: registry,
      providerAccountRepository: new PostgresProviderAccountRepository(handle.database),
      credentialStore,
      auditRecorder,
      conversationService,
      messageRepository,
      inboundProviders: { GMAIL: new GmailInboundProvider(), MICROSOFT365: graph },
      graphInboundProvider: graph,
      listUnmaterialized: (limit) => createUnmaterializedSentIntentReader(handle.database).list(limit),
      logger,
    });
    const result = await materializer.runTick();
    expect(result.unmatched).toBe(1);
    expect(result.materialized).toBe(0);
    const count = await handle.database.query<{ n: string }>("SELECT count(*)::text AS n FROM conversation_messages");
    expect(count[0]?.n).toBe("0");
  });
});
