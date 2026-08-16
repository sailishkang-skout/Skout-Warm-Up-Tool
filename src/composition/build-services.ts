import { createApiCredentialService, type ApiCredentialService } from "../modules/auth/application/api-credential-service.js";
import { createAuthenticationService, type AuthenticationService } from "../modules/auth/application/authentication-service.js";
import { PostgresApiCredentialRepository } from "../modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createDomainIntelligenceService, type DomainIntelligenceService } from "../modules/domain-intelligence/application/domain-intelligence-service.js";
import { createNodeDnsResolver } from "../modules/domain-intelligence/infrastructure/node-dns-resolver.js";
import { createPostgresDomainIntelligenceRepository } from "../modules/domain-intelligence/infrastructure/postgres-domain-intelligence-repository.js";
import { createRedisDomainCache } from "../modules/domain-intelligence/infrastructure/redis-domain-cache.js";
import { createMailboxAssessmentService, type MailboxAssessmentService } from "../modules/health/application/mailbox-assessment-service.js";
import { PostgresMailboxAssessmentRepository } from "../modules/health/infrastructure/postgres-mailbox-assessment-repository.js";
import { PostgresMailboxSignalRepository } from "../modules/health/infrastructure/postgres-mailbox-signal-repository.js";
import { createMailboxService, type MailboxService } from "../modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createOAuthConnectionService, type OAuthConnectionService } from "../modules/oauth/application/oauth-connection-service.js";
import { createRedisOAuthConnectionLock } from "../modules/oauth/infrastructure/redis-oauth-connection-lock.js";
import { createRedisOAuthStateStore } from "../modules/oauth/infrastructure/redis-oauth-state-store.js";
import { PostgresConnectionAttemptRepository } from "../modules/oauth/infrastructure/postgres-connection-attempt-repository.js";
import { createProviderRegistry, type ProviderRegistry } from "../modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../modules/providers/infrastructure/gmail/gmail-adapter.js";
import { Microsoft365Adapter } from "../modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { PostgresProviderAccountRepository } from "../modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createPostgresProviderCredentialStore } from "../modules/providers/infrastructure/postgres-provider-credential-store.js";
import { SmtpImapAdapter } from "../modules/providers/infrastructure/smtp-imap/smtp-imap-adapter.js";
import { PostgresTenantRepository } from "../modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { createExecutionWorker, type ExecutionWorker } from "../modules/warmup/application/execution-worker.js";
import { createWarmupService, type WarmupService } from "../modules/warmup/application/warmup-service.js";
import { createUnimplementedWarmupSendProvider } from "../modules/warmup/infrastructure/unimplemented-warmup-send-provider.js";
import { PostgresWarmupDecisionRepository } from "../modules/warmup/infrastructure/postgres-warmup-decision-repository.js";
import { PostgresWarmupExecutionIntentRepository } from "../modules/warmup/infrastructure/postgres-warmup-execution-intent-repository.js";
import { PostgresWarmupProfileRepository } from "../modules/warmup/infrastructure/postgres-warmup-profile-repository.js";
import { PostgresWarmupSessionRepository } from "../modules/warmup/infrastructure/postgres-warmup-session-repository.js";
import { createEncryptionService } from "../shared/crypto/index.js";
import type { AppConfig } from "../shared/config/index.js";
import type { Database } from "../shared/db/index.js";
import type { Logger } from "../shared/logger/index.js";
import type { RedisClient } from "../shared/redis/index.js";

export interface AppServices {
  readonly authenticationService: AuthenticationService;
  readonly credentialService: ApiCredentialService;
  readonly mailboxService: MailboxService;
  readonly providerRegistry: ProviderRegistry;
  readonly oauthConnectionService: OAuthConnectionService;
  readonly domainIntelligenceService: DomainIntelligenceService;
  readonly mailboxAssessmentService: MailboxAssessmentService;
  readonly warmupService: WarmupService;
  readonly executionWorker: ExecutionWorker;
}

/**
 * Single composition root: constructs every repository and application
 * service and wires them together. `app.ts` only registers plugins/routes
 * against the result — it does not construct any repository or service
 * itself. Domain/application modules never import from here (the
 * dependency only ever points this direction).
 */
export function buildServices(config: AppConfig, logger: Logger, database: Database, redis: RedisClient): AppServices {
  const tenantRepository = new PostgresTenantRepository(database);
  const credentialRepository = new PostgresApiCredentialRepository(database);
  const auditRecorder = createPostgresAuditEventRecorder(database, logger);

  const authenticationService = createAuthenticationService({
    credentialRepository,
    tenantRepository,
    auditRecorder,
    pepper: config.security.apiKeyPepper,
  });

  const credentialService = createApiCredentialService({
    repository: credentialRepository,
    auditRecorder,
    pepper: config.security.apiKeyPepper,
  });

  // Only one key registered today (currentVersion 1) — a future rotation
  // adds another entry here at a higher version and bumps currentVersion;
  // see src/shared/crypto/encryption-service.ts for why old versions stay
  // registered rather than being replaced.
  const encryptionService = createEncryptionService([{ version: 1, rawKey: config.security.encryptionKey }], 1);

  const providerRegistry = createProviderRegistry();
  // Each adapter reports NOT_CONFIGURED (and every OAuth-specific method
  // throws ConfigurationError) when its provider's env vars are absent —
  // this deployment can run with only a subset of providers enabled, per
  // Stage 6 spec section 24, with no code branch anywhere else needing to
  // know which.
  providerRegistry.register(new GmailAdapter(config.providers.google ? { config: config.providers.google } : {}));
  providerRegistry.register(
    new Microsoft365Adapter(config.providers.microsoft ? { config: config.providers.microsoft } : {}),
  );
  providerRegistry.register(new SmtpImapAdapter());

  // The only production-safe `ProviderCredentialStore` — every credential is
  // AES-256-GCM encrypted before it reaches Postgres (see
  // src/modules/providers/infrastructure/postgres-provider-credential-store.ts).
  // Unlike Stage 5's in-memory store, this one no longer refuses to
  // construct in production.
  const credentialStore = createPostgresProviderCredentialStore(database, encryptionService);

  const mailboxService = createMailboxService({
    database,
    mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
    providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
    providerRegistry,
    credentialStore,
    auditRecorder,
  });

  const oauthConnectionService = createOAuthConnectionService({
    mailboxRepository: new PostgresMailboxRepository(database),
    providerAccountRepository: new PostgresProviderAccountRepository(database),
    providerRegistry,
    credentialStore,
    stateStore: createRedisOAuthStateStore(redis),
    connectionLock: createRedisOAuthConnectionLock(redis),
    connectionAttemptRepository: new PostgresConnectionAttemptRepository(database),
    auditRecorder,
    mailboxService,
  });

  const domainIntelligenceService = createDomainIntelligenceService({
    cache: createRedisDomainCache(redis),
    repository: createPostgresDomainIntelligenceRepository(database),
    resolver: createNodeDnsResolver(),
  });

  const mailboxAssessmentService = createMailboxAssessmentService({
    mailboxService,
    domainIntelligenceService,
    signalRepository: new PostgresMailboxSignalRepository(database),
    assessmentRepository: new PostgresMailboxAssessmentRepository(database),
  });

  const warmupProfileRepository = new PostgresWarmupProfileRepository(database);
  const warmupSessionRepository = new PostgresWarmupSessionRepository(database);
  const warmupDecisionRepository = new PostgresWarmupDecisionRepository(database);
  const warmupExecutionIntentRepository = new PostgresWarmupExecutionIntentRepository(database);

  const warmupService = createWarmupService({
    mailboxService,
    mailboxAssessmentService,
    warmupProfileRepository,
    sessionRepository: warmupSessionRepository,
    decisionRepository: warmupDecisionRepository,
    intentRepository: warmupExecutionIntentRepository,
    auditRecorder,
  });

  // No real provider send capability exists yet this stage — every call
  // reports an honest, non-retryable PERMANENT_FAILURE rather than
  // fabricating success (see unimplemented-warmup-send-provider.ts).
  const executionWorker = createExecutionWorker({
    intentRepository: warmupExecutionIntentRepository,
    sessionRepository: warmupSessionRepository,
    warmupProfileRepository,
    mailboxService,
    mailboxAssessmentService,
    sendProvider: createUnimplementedWarmupSendProvider(),
    auditRecorder,
  });

  return {
    authenticationService,
    credentialService,
    mailboxService,
    providerRegistry,
    oauthConnectionService,
    domainIntelligenceService,
    mailboxAssessmentService,
    warmupService,
    executionWorker,
  };
}
