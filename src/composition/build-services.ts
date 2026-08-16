import { createApiCredentialService, type ApiCredentialService } from "../modules/auth/application/api-credential-service.js";
import { createAuthenticationService, type AuthenticationService } from "../modules/auth/application/authentication-service.js";
import { PostgresApiCredentialRepository } from "../modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../modules/audit/infrastructure/postgres-audit-event-recorder.js";
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

  return { authenticationService, credentialService, mailboxService, providerRegistry, oauthConnectionService };
}
