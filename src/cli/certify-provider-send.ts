import "dotenv/config";
import { certifyProviderSend } from "../modules/providers/application/provider-certification.js";
import { createProviderRegistry } from "../modules/providers/application/provider-registry.js";
import { GmailAdapter } from "../modules/providers/infrastructure/gmail/gmail-adapter.js";
import { Microsoft365Adapter } from "../modules/providers/infrastructure/microsoft365/microsoft365-adapter.js";
import { PostgresProviderAccountRepository } from "../modules/providers/infrastructure/postgres-provider-account-repository.js";
import { createPostgresProviderCredentialStore } from "../modules/providers/infrastructure/postgres-provider-credential-store.js";
import { SmtpImapAdapter } from "../modules/providers/infrastructure/smtp-imap/smtp-imap-adapter.js";
import { createPostgresAuditEventRecorder } from "../modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { PostgresMailboxRepository } from "../modules/mailbox/infrastructure/postgres-mailbox-repository.js";
import { createEncryptionService } from "../shared/crypto/index.js";
import { loadConfig, type AppConfig } from "../shared/config/index.js";
import { createDatabase, createPool } from "../shared/db/index.js";
import { createLogger } from "../shared/logger/index.js";
import { asMailboxId, asTenantId } from "../shared/types/index.js";

// ============================================================================
// Hardening spec Gap B: a controlled, manually-triggered live-send
// certification path — the ONLY place in this codebase that is allowed to
// send a real email through a real provider connection outside a test's
// mocked fetch. Every gate below exists specifically so this can never run
// by accident:
//
//   1. Requires ALLOW_LIVE_PROVIDER_CERTIFICATION=true verbatim — checked
//      BEFORE any database/network connection is opened, so a missing or
//      wrong value fails in milliseconds with no side effects.
//   2. Requires CERTIFICATION_TENANT_ID / CERTIFICATION_MAILBOX_ID /
//      CERTIFICATION_RECIPIENT_EMAIL as environment variables with no
//      defaults — there is no hardcoded tenant, mailbox, or recipient
//      anywhere in this file (Gap B section 3/4).
//   3. Is a standalone script under src/cli/, exactly like migrate.ts and
//      bootstrap-tenant.ts — never imported by src/app.ts,
//      src/composition/build-services.ts, or any code reachable from the
//      running HTTP server or the execution worker. Nothing in ordinary
//      warmup execution can reach this file, accidentally or otherwise
//      (Gap B section 6).
//   4. Is never invoked by `npm test` / `npm run test:db` / any CI script
//      in this repository — only a human running
//      `npm run certify:provider-send` with the above variables explicitly
//      exported for that one invocation (Gap B section 1/2).
//   5. Reuses the exact production send path (certifyProviderSend →
//      ProviderRegistry → ProviderAdapter.sendMessage) rather than a
//      second, parallel "test send" implementation — certifying anything
//      else would prove nothing about what actually runs in production.
//
// See docs/PROVIDER_CERTIFICATION_RUNBOOK.md for the full manual procedure.
// ============================================================================

function requireOptIn(): void {
  if (process.env.ALLOW_LIVE_PROVIDER_CERTIFICATION !== "true") {
    console.error(
      "Refusing to run: ALLOW_LIVE_PROVIDER_CERTIFICATION is not set to 'true'.\n" +
        "This script sends one real email through a real, already-connected provider account.\n" +
        "See docs/PROVIDER_CERTIFICATION_RUNBOOK.md before setting this.",
    );
    process.exit(1);
  }
}

interface CertificationEnv {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly recipientEmail: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireCertificationEnv(): CertificationEnv {
  const tenantId = process.env.CERTIFICATION_TENANT_ID;
  const mailboxId = process.env.CERTIFICATION_MAILBOX_ID;
  const recipientEmail = process.env.CERTIFICATION_RECIPIENT_EMAIL;

  const missing = [
    !tenantId ? "CERTIFICATION_TENANT_ID" : undefined,
    !mailboxId ? "CERTIFICATION_MAILBOX_ID" : undefined,
    !recipientEmail ? "CERTIFICATION_RECIPIENT_EMAIL" : undefined,
  ].filter((name): name is string => name !== undefined);
  if (missing.length > 0) {
    console.error(`Refusing to run: missing required environment variable(s): ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!EMAIL_PATTERN.test(recipientEmail!)) {
    console.error("Refusing to run: CERTIFICATION_RECIPIENT_EMAIL does not look like a valid email address.");
    process.exit(1);
  }

  return { tenantId: tenantId!, mailboxId: mailboxId!, recipientEmail: recipientEmail! };
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    console.error("Invalid configuration:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Gate 1 and 2 run before anything else in this file touches the network
// or a database connection.
requireOptIn();
const certificationEnv = requireCertificationEnv();
const config = loadConfigOrExit();

const logger = createLogger({ level: config.log.level, serviceName: config.service.name, env: config.env });
const pool = createPool(config.database, logger);
const database = createDatabase(pool, logger);

try {
  const tenantId = asTenantId(certificationEnv.tenantId);
  const mailboxId = asMailboxId(certificationEnv.mailboxId);

  const providerRegistry = createProviderRegistry();
  providerRegistry.register(new GmailAdapter(config.providers.google ? { config: config.providers.google } : {}));
  providerRegistry.register(new Microsoft365Adapter(config.providers.microsoft ? { config: config.providers.microsoft } : {}));
  providerRegistry.register(new SmtpImapAdapter());

  const encryptionService = createEncryptionService([{ version: 1, rawKey: config.security.encryptionKey }], 1);
  const credentialStore = createPostgresProviderCredentialStore(database, encryptionService);
  const auditRecorder = createPostgresAuditEventRecorder(database, logger);

  const mailbox = await new PostgresMailboxRepository(database).findById(tenantId, mailboxId);
  if (!mailbox) {
    console.error(`No mailbox ${mailboxId} found for tenant ${tenantId}.`);
    process.exitCode = 1;
  } else {
    const providerAccount = await new PostgresProviderAccountRepository(database).findByMailboxId(tenantId, mailboxId);
    if (!providerAccount) {
      console.error(`Mailbox ${mailboxId} has no connected provider account — connect it via OAuth before certifying.`);
      process.exitCode = 1;
    } else {
      console.log(`Certifying ${mailbox.provider} send for mailbox ${mailbox.emailAddressCanonical} → ${certificationEnv.recipientEmail} ...`);

      const { outcome } = await certifyProviderSend(
        { providerRegistry, credentialStore, auditRecorder },
        {
          tenantId,
          providerAccountId: providerAccount.id,
          provider: mailbox.provider,
          fromAddress: mailbox.emailAddressCanonical,
          recipientEmail: certificationEnv.recipientEmail,
        },
      );

      console.log("Result:");
      console.log(`  status:    ${outcome.status}`);
      console.log(`  retryable: ${outcome.retryable}`);
      if (outcome.providerMessageId) console.log(`  messageId: ${outcome.providerMessageId}`);
      if (outcome.safeReason) console.log(`  reason:    ${outcome.safeReason}`);
      console.log();
      console.log(
        outcome.status === "ACCEPTED"
          ? "ACCEPTED — now verify Skout's own state matches (no execution intent should exist for this send; check the mailbox's actual sent folder to confirm delivery)."
          : "Not ACCEPTED — this provider/credential combination is not certified. Do not enable it for warmup traffic yet.",
      );
      process.exitCode = outcome.status === "ACCEPTED" ? 0 : 1;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await database.close().catch(() => undefined);
}
