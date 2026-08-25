import { createApiCredentialService, type ApiCredentialService } from "../modules/auth/application/api-credential-service.js";
import { createAuthenticationService, type AuthenticationService } from "../modules/auth/application/authentication-service.js";
import { PostgresApiCredentialRepository } from "../modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createDeliveryEventService, type DeliveryEventService } from "../modules/delivery-events/application/delivery-event-service.js";
import { PostgresDeliveryEventRepository } from "../modules/delivery-events/infrastructure/postgres-delivery-event-repository.js";
import { createDomainIntelligenceService, type DomainIntelligenceService } from "../modules/domain-intelligence/application/domain-intelligence-service.js";
import { createNodeDnsResolver } from "../modules/domain-intelligence/infrastructure/node-dns-resolver.js";
import { createPostgresDomainIntelligenceRepository } from "../modules/domain-intelligence/infrastructure/postgres-domain-intelligence-repository.js";
import { createRedisDomainCache } from "../modules/domain-intelligence/infrastructure/redis-domain-cache.js";
import { createMailboxAssessmentService, type MailboxAssessmentService } from "../modules/health/application/mailbox-assessment-service.js";
import { createRedisAssessmentInvalidationStore } from "../modules/health/infrastructure/redis-assessment-invalidation-store.js";
import { PostgresMailboxAssessmentRepository } from "../modules/health/infrastructure/postgres-mailbox-assessment-repository.js";
import { PostgresMailboxSignalRepository } from "../modules/health/infrastructure/postgres-mailbox-signal-repository.js";
import { createMailboxService, type MailboxService } from "../modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createOAuthConnectionService, type OAuthConnectionService } from "../modules/oauth/application/oauth-connection-service.js";
import { createRedisOAuthConnectionLock } from "../modules/oauth/infrastructure/redis-oauth-connection-lock.js";
import { createRedisOAuthStateStore } from "../modules/oauth/infrastructure/redis-oauth-state-store.js";
import { PostgresConnectionAttemptRepository } from "../modules/oauth/infrastructure/postgres-connection-attempt-repository.js";
import { createProviderRegistry, type ProviderRegistry } from "../modules/providers/application/provider-registry.js";
import { createConversationFactsPoller, type ConversationFactsPoller } from "../modules/conversations/application/conversation-facts-poller.js";
import { createConversationService, type ConversationService } from "../modules/conversations/application/conversation-service.js";
import { createInboundSyncService, type InboundSyncService } from "../modules/conversations/application/inbound-sync-service.js";
import { createOutboundMaterializer, type OutboundMaterializer } from "../modules/conversations/application/outbound-materializer.js";
import {
  createClassificationWorker,
  type ClassificationQueryService,
  type ClassificationWorker,
} from "../modules/conversations/application/classification-worker.js";
import {
  createConversationPolicyWorker,
  type ConversationPolicyQueryService,
  type ConversationPolicyWorker,
} from "../modules/conversations/application/policy-evaluation-worker.js";
import {
  createHybridConversationClassifier,
  createValidatingConversationClassifier,
} from "../modules/conversations/application/conversation-classifier.js";
import { PostgresClassificationRepository } from "../modules/conversations/infrastructure/postgres-classification-repository.js";
import type { IntegrationEventRepository } from "../modules/conversations/application/integration-event-repository.js";
import { PostgresConversationPolicyRepository } from "../modules/conversations/infrastructure/postgres-conversation-policy-repository.js";
import { PostgresIntegrationEventRepository } from "../modules/conversations/infrastructure/postgres-integration-event-repository.js";
import { HttpAiClassifierProvider } from "../modules/conversations/infrastructure/http-ai-classifier-provider.js";
import { PostgresConversationMessageRepository } from "../modules/conversations/infrastructure/postgres-conversation-message-repository.js";
import { PostgresConversationRepository } from "../modules/conversations/infrastructure/postgres-conversation-repository.js";
import { PostgresInboundSyncStateRepository } from "../modules/conversations/infrastructure/postgres-inbound-sync-state-repository.js";
import { createPollableMailboxReader } from "../modules/conversations/infrastructure/pollable-mailbox-reader.js";
import { createUnmaterializedSentIntentReader } from "../modules/conversations/infrastructure/unmaterialized-sent-intent-reader.js";
import { GmailAdapter } from "../modules/providers/infrastructure/gmail/gmail-adapter.js";
import { GmailInboundProvider } from "../modules/providers/infrastructure/gmail/gmail-inbound-provider.js";
import { Microsoft365InboundProvider } from "../modules/providers/infrastructure/microsoft365/microsoft365-inbound-provider.js";
import { Microsoft365Adapter } from "../modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { PostgresProviderAccountRepository } from "../modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createPostgresProviderCredentialStore } from "../modules/providers/infrastructure/postgres-provider-credential-store.js";
import { SmtpImapAdapter } from "../modules/providers/infrastructure/smtp-imap/smtp-imap-adapter.js";
import { createReputationService, type ReputationService } from "../modules/reputation/application/reputation-service.js";
import { PostgresReputationRepository } from "../modules/reputation/infrastructure/postgres-reputation-repository.js";
import { PostgresTenantRepository } from "../modules/tenancy/infrastructure/postgres-tenant-repository.js";
import type { TenantRepository } from "../modules/tenancy/application/tenant-repository.js";
import { createExecutionWorker, type ExecutionWorker } from "../modules/warmup/application/execution-worker.js";
import { createWarmupProfileService, type WarmupProfileService } from "../modules/warmup/application/warmup-profile-service.js";
import { createWarmupReconciliationService, type WarmupReconciliationService } from "../modules/warmup/application/warmup-reconciliation-service.js";
import { createWarmupScheduler, type WarmupScheduler } from "../modules/warmup/application/warmup-scheduler.js";
import { createWarmupService, type WarmupService } from "../modules/warmup/application/warmup-service.js";
import { createAdapterWarmupSendProvider } from "../modules/warmup/infrastructure/adapter-warmup-send-provider.js";
import { createWarmupNetworkRouter } from "../modules/warmup-network/application/warmup-network-router.js";
import { createCustomerDomainService, type CustomerDomainService } from "../modules/customer-domains/application/customer-domain-service.js";
import { createGoogleWorkspaceDirectoryProvider } from "../modules/managed-directory/infrastructure/google-workspace-directory-provider.js";
import { createMicrosoft365DirectoryProvider } from "../modules/managed-directory/infrastructure/microsoft365-directory-provider.js";
import { createMailboxProvisioningService, type MailboxProvisioningService } from "../modules/managed-directory/application/mailbox-provisioning-service.js";
import { createKillSwitchService, type KillSwitchService } from "../modules/operations/application/kill-switch-service.js";
import { createWarmupNetworkService, type WarmupNetworkService } from "../modules/warmup-network/application/warmup-network-service.js";
import { PostgresWarmupNetworkRepository } from "../modules/warmup-network/infrastructure/postgres-warmup-network-repository.js";
import { createWarmupPoolService, type WarmupPoolService } from "../modules/warmup-pool/application/warmup-pool-service.js";
import { PostgresWarmupPoolRepository } from "../modules/warmup-pool/infrastructure/postgres-warmup-pool-repository.js";
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
  readonly tenantRepository: TenantRepository;
  readonly mailboxService: MailboxService;
  readonly providerRegistry: ProviderRegistry;
  readonly oauthConnectionService: OAuthConnectionService;
  readonly domainIntelligenceService: DomainIntelligenceService;
  readonly deliveryEventService: DeliveryEventService;
  readonly reputationService: ReputationService;
  readonly mailboxAssessmentService: MailboxAssessmentService;
  readonly warmupService: WarmupService;
  readonly warmupProfileService: WarmupProfileService;
  readonly warmupReconciliationService: WarmupReconciliationService;
  readonly executionWorker: ExecutionWorker;
  readonly warmupScheduler: WarmupScheduler;
  readonly conversationService: ConversationService;
  readonly inboundSyncService: InboundSyncService;
  readonly outboundMaterializer: OutboundMaterializer;
  readonly conversationFactsPoller: ConversationFactsPoller;
  readonly classificationWorker: ClassificationWorker;
  readonly classificationQuery: ClassificationQueryService;
  readonly policyWorker: ConversationPolicyWorker;
  readonly policyQuery: ConversationPolicyQueryService;
  readonly integrationEventRepository: IntegrationEventRepository;
  readonly warmupNetworkService: WarmupNetworkService;
  readonly warmupPoolService: WarmupPoolService;
  readonly customerDomainService: CustomerDomainService;
  readonly mailboxProvisioningService: MailboxProvisioningService;
  readonly killSwitchService: KillSwitchService;
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
  // Stage 12.1: refreshTimeoutMs always passed explicitly (unlike
  // config/fetchImpl, which are conditional on provider configuration) —
  // bounding the refresh call is unconditional, independent of whether
  // this deployment has real OAuth credentials configured.
  providerRegistry.register(
    new GmailAdapter({ ...(config.providers.google ? { config: config.providers.google } : {}), refreshTimeoutMs: config.providers.credentialRefreshTimeoutMs }),
  );
  providerRegistry.register(
    new Microsoft365Adapter({ ...(config.providers.microsoft ? { config: config.providers.microsoft } : {}), refreshTimeoutMs: config.providers.credentialRefreshTimeoutMs }),
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

  // Stage 10's feedback loop: delivery-events (raw evidence) → reputation
  // (mailbox-level assessment) → risk (consumed as an additional factor
  // source, see risk/application/risk-policy.ts) → the existing ramp/
  // decision engine, unchanged. `invalidationStore` is the narrow,
  // dependency-free port both `delivery-events` (marks stale) and `health`
  // (checks/clears) depend on directly — see
  // health/application/assessment-invalidation-store.ts's doc comment for
  // why this avoids a module dependency cycle.
  const invalidationStore = createRedisAssessmentInvalidationStore(redis);
  const deliveryEventService = createDeliveryEventService({
    deliveryEventRepository: new PostgresDeliveryEventRepository(database),
    mailboxService,
    invalidationStore,
    auditRecorder,
  });
  const reputationService = createReputationService({
    deliveryEventService,
    reputationRepository: new PostgresReputationRepository(database),
    auditRecorder,
    // Stage 11: resolves each mailbox's provider/sending domain and reuses
    // domain-intelligence's already-cached DNS facts — no second DNS
    // resolver, no new module dependency cycle (mailbox/domain-intelligence
    // depend on neither reputation nor health).
    mailboxService,
    domainIntelligenceService,
  });

  const mailboxAssessmentService = createMailboxAssessmentService({
    mailboxService,
    domainIntelligenceService,
    signalRepository: new PostgresMailboxSignalRepository(database),
    assessmentRepository: new PostgresMailboxAssessmentRepository(database),
    reputationService,
    invalidationStore,
  });

  const warmupProfileRepository = new PostgresWarmupProfileRepository(database);
  const warmupSessionRepository = new PostgresWarmupSessionRepository(database);
  const warmupDecisionRepository = new PostgresWarmupDecisionRepository(database);
  const warmupExecutionIntentRepository = new PostgresWarmupExecutionIntentRepository(database);
  const warmupPoolRepository = new PostgresWarmupPoolRepository(database);

  const warmupService = createWarmupService({
    mailboxService,
    mailboxAssessmentService,
    warmupProfileRepository,
    sessionRepository: warmupSessionRepository,
    decisionRepository: warmupDecisionRepository,
    intentRepository: warmupExecutionIntentRepository,
    auditRecorder,
    poolIntentHook: warmupPoolRepository,
  });

  const warmupProfileService = createWarmupProfileService({ mailboxService, warmupProfileRepository });
  const warmupReconciliationService = createWarmupReconciliationService({
    intentRepository: warmupExecutionIntentRepository,
    auditRecorder,
  });

  const killSwitchService = createKillSwitchService({
    database,
    auditRecorder,
    envGlobalPause: config.warmupNetwork.globalKillSwitch,
  });
  const customerDomainService = createCustomerDomainService({ database, auditRecorder });
  const mailboxProvisioningService = createMailboxProvisioningService({
    database,
    mailboxService,
    auditRecorder,
    directories: {
      GMAIL: createGoogleWorkspaceDirectoryProvider(false),
      MICROSOFT365: createMicrosoft365DirectoryProvider(false),
    },
  });
  const warmupNetworkRepository = new PostgresWarmupNetworkRepository(database);
  const warmupNetworkRouter = createWarmupNetworkRouter({
    database,
    mailboxService,
    repository: warmupNetworkRepository,
    auditRecorder,
    config: config.warmupNetwork,
  });
  const warmupNetworkService = createWarmupNetworkService(warmupNetworkRepository);
  const warmupPoolService = createWarmupPoolService({
    database,
    repository: warmupPoolRepository,
    mailboxService,
    warmupService,
    auditRecorder,
    config: config.warmupPool,
  });

  // The real Stage 9 send boundary: resolves the right ProviderAdapter
  // through the same ProviderRegistry every other module uses, and the
  // same resolveFreshCredential mailbox/oauth already depend on — no
  // second credential-refresh implementation, no second OAuth system (see
  // src/modules/warmup/infrastructure/adapter-warmup-send-provider.ts).
  // SMTP/IMAP has no `sendMessage` implementation yet, so it safely
  // reports PROVIDER_SEND_UNAVAILABLE rather than faking a send.
  // Stage 20: recipient routing is opt-in (`WARMUP_NETWORK_ROUTING_MODE`,
  // default off = self-send, no network queries).
  const executionWorker = createExecutionWorker({
    intentRepository: warmupExecutionIntentRepository,
    sessionRepository: warmupSessionRepository,
    warmupProfileRepository,
    mailboxService,
    mailboxAssessmentService,
    sendProvider: createAdapterWarmupSendProvider({
      mailboxService,
      providerAccountRepository: new PostgresProviderAccountRepository(database),
      credentialStore,
      providerRegistry,
      auditRecorder,
      warmupNetworkRouter,
      warmupNetworkRoutingMode: config.warmupNetwork.routingMode,
      isExecutionPaused: () => killSwitchService.isGlobalPaused(),
    }),
    auditRecorder,
    logger,
  });

  // Stage 12: the scheduler answers "when," never "is it safe" — every
  // responsibility here delegates to already-existing logic
  // (reclaimExpiredLeases, WarmupService.advanceDailyWarmup, the
  // unmodified executionWorker.processNext). See warmup/README.md's Stage
  // 12 section and src/workers/execution-worker-process.ts, the only
  // production caller of `runTick`.
  const warmupScheduler = createWarmupScheduler({
    warmupService,
    sessionRepository: warmupSessionRepository,
    intentRepository: warmupExecutionIntentRepository,
    executionWorker,
    auditRecorder,
    logger,
  });

  const conversationRepository = new PostgresConversationRepository(database);
  const conversationMessageRepository = new PostgresConversationMessageRepository(database);
  const inboundSyncStateRepository = new PostgresInboundSyncStateRepository(database);
  const classificationRepository = new PostgresClassificationRepository(database);
  const conversationService = createConversationService({
    database,
    mailboxService,
    conversationRepository,
    messageRepository: conversationMessageRepository,
    auditRecorder,
    classificationRepository,
    classifierVersion: config.ai.classifierVersion,
    taxonomyVersion: config.ai.taxonomyVersion,
  });
  const gmailInboundProvider = new GmailInboundProvider();
  const microsoft365InboundProvider = new Microsoft365InboundProvider();
  const inboundProviders = { GMAIL: gmailInboundProvider, MICROSOFT365: microsoft365InboundProvider } as const;
  const pollableMailboxReader = createPollableMailboxReader(database);
  const unmaterializedSentIntentReader = createUnmaterializedSentIntentReader(database);
  const providerAccountRepository = new PostgresProviderAccountRepository(database);

  const inboundSyncService = createInboundSyncService({
    database,
    mailboxService,
    providerRegistry,
    providerAccountRepository,
    credentialStore,
    auditRecorder,
    conversationService,
    syncStateRepository: inboundSyncStateRepository,
    listPollableMailboxes: () => pollableMailboxReader.list(),
    inboundProviders,
    logger,
  });

  const outboundMaterializer = createOutboundMaterializer({
    mailboxService,
    providerRegistry,
    providerAccountRepository,
    credentialStore,
    auditRecorder,
    conversationService,
    messageRepository: conversationMessageRepository,
    inboundProviders,
    graphInboundProvider: microsoft365InboundProvider,
    listUnmaterialized: (limit) => unmaterializedSentIntentReader.list(limit),
    logger,
  });

  const conversationFactsPoller = createConversationFactsPoller(inboundSyncService, outboundMaterializer);

  const aiProvider =
    config.ai.provider !== "none" && config.ai.apiKey
      ? new HttpAiClassifierProvider({
          provider: config.ai.provider,
          apiKey: config.ai.apiKey,
          baseUrl: config.ai.baseUrl,
          model: config.ai.model,
          timeoutMs: config.ai.timeoutMs,
          maxOutputChars: config.ai.maxOutputChars,
        })
      : undefined;
  const aiClassifier = aiProvider
    ? createValidatingConversationClassifier({ aiProvider, maxInputChars: config.ai.maxInputChars })
    : undefined;
  const classifier = createHybridConversationClassifier({
    ...(aiClassifier ? { aiClassifier } : {}),
    supplementDeterministic: config.ai.supplementDeterministic,
  });
  const classificationRuntime = createClassificationWorker({
    conversationService,
    messageRepository: conversationMessageRepository,
    classificationRepository,
    classifier,
    classifierVersion: config.ai.classifierVersion,
    taxonomyVersion: config.ai.taxonomyVersion,
    modelName: config.ai.model,
    maxInputChars: config.ai.maxInputChars,
    auditRecorder,
    logger,
  });
  const policyRuntime = createConversationPolicyWorker({
    conversationService,
    policyRepository: new PostgresConversationPolicyRepository(database),
    policyVersion: config.conversations.policyVersion,
    taxonomyVersion: config.conversations.policyTaxonomyVersion,
    auditRecorder,
    logger,
  });
  const integrationEventRepository = new PostgresIntegrationEventRepository(database);

  return {
    authenticationService,
    credentialService,
    tenantRepository,
    mailboxService,
    providerRegistry,
    oauthConnectionService,
    domainIntelligenceService,
    deliveryEventService,
    reputationService,
    mailboxAssessmentService,
    warmupService,
    warmupProfileService,
    warmupReconciliationService,
    executionWorker,
    warmupScheduler,
    conversationService,
    inboundSyncService,
    outboundMaterializer,
    conversationFactsPoller,
    classificationWorker: classificationRuntime,
    classificationQuery: classificationRuntime,
    policyWorker: policyRuntime,
    policyQuery: policyRuntime,
    integrationEventRepository,
    warmupNetworkService,
    warmupPoolService,
    customerDomainService,
    mailboxProvisioningService,
    killSwitchService,
  };
}
