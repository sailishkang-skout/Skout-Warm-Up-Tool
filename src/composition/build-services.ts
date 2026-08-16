import { createApiCredentialService, type ApiCredentialService } from "../modules/auth/application/api-credential-service.js";
import { createAuthenticationService, type AuthenticationService } from "../modules/auth/application/authentication-service.js";
import { PostgresApiCredentialRepository } from "../modules/auth/infrastructure/postgres-api-credential-repository.js";
import { createPostgresAuditEventRecorder } from "../modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createMailboxService, type MailboxService } from "../modules/mailbox/application/mailbox-service.js";
import { PostgresMailboxRepository } from "../modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createProviderRegistry, type ProviderRegistry } from "../modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../modules/providers/infrastructure/gmail/gmail-adapter.js";
import { createInMemoryProviderCredentialStore } from "../modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { Microsoft365Adapter } from "../modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { PostgresProviderAccountRepository } from "../modules/providers/infrastructure/postgres-provider-account-repository.js";
import { SmtpImapAdapter } from "../modules/providers/infrastructure/smtp-imap/smtp-imap-adapter.js";
import { PostgresTenantRepository } from "../modules/tenancy/infrastructure/postgres-tenant-repository.js";
import type { AppConfig } from "../shared/config/index.js";
import type { Database } from "../shared/db/index.js";
import type { Logger } from "../shared/logger/index.js";

export interface AppServices {
  readonly authenticationService: AuthenticationService;
  readonly credentialService: ApiCredentialService;
  readonly mailboxService: MailboxService;
  readonly providerRegistry: ProviderRegistry;
}

/**
 * Single composition root: constructs every repository and application
 * service and wires them together. `app.ts` only registers plugins/routes
 * against the result — it does not construct any repository or service
 * itself. Domain/application modules never import from here (the
 * dependency only ever points this direction).
 */
export function buildServices(config: AppConfig, logger: Logger, database: Database): AppServices {
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

  const providerRegistry = createProviderRegistry();
  providerRegistry.register(new GmailAdapter());
  providerRegistry.register(new Microsoft365Adapter());
  providerRegistry.register(new SmtpImapAdapter());

  // Refuses to construct in production — see the store's own doc comment.
  // No production-grade credential store exists yet, so this deployment
  // genuinely cannot support production mailbox connections until one does.
  const credentialStore = createInMemoryProviderCredentialStore({ isProduction: config.isProduction });

  const mailboxService = createMailboxService({
    database,
    mailboxRepositoryFactory: (db) => new PostgresMailboxRepository(db),
    providerAccountRepositoryFactory: (db) => new PostgresProviderAccountRepository(db),
    providerRegistry,
    credentialStore,
  });

  return { authenticationService, credentialService, mailboxService, providerRegistry };
}
