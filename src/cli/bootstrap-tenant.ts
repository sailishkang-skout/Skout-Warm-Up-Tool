import "dotenv/config";
import { createPostgresAuditEventRecorder } from "../modules/audit/infrastructure/postgres-audit-event-recorder.js";
import { createApiCredentialService } from "../modules/auth/application/api-credential-service.js";
import { PostgresApiCredentialRepository } from "../modules/auth/infrastructure/postgres-api-credential-repository.js";
import { PostgresTenantRepository } from "../modules/tenancy/infrastructure/postgres-tenant-repository.js";
import { loadConfig, type AppConfig } from "../shared/config/index.js";
import { createDatabase, createPool } from "../shared/db/index.js";
import { createLogger } from "../shared/logger/index.js";

// This is the deliberate, explicit provisioning path (Stage 4 spec, section
// 16/17): there is no public HTTP endpoint that creates tenants or first
// credentials — that would mean anyone on the internet could self-provision
// a tenant. Creating one requires direct database access (the same
// DATABASE_URL this CLI, and only this CLI/migrate.ts, uses), which is a
// meaningfully higher bar than an HTTP endpoint. Once a tenant has this
// first credential, all further credential management goes through the
// authenticated /api/v1/credentials HTTP API.

interface ParsedArgs {
  readonly tenantName: string;
  readonly credentialName: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [tenantName, ...rest] = argv;
  if (!tenantName || tenantName.startsWith("--")) {
    console.error("Usage: bootstrap-tenant <tenant-name> [--credential-name <name>]");
    process.exit(1);
  }

  let credentialName = "Bootstrap credential";
  for (let index = 0; index < rest.length; index += 1) {
    const next = rest[index + 1];
    if (rest[index] === "--credential-name" && next) {
      credentialName = next;
      index += 1;
    }
  }

  return { tenantName, credentialName };
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    console.error("Invalid configuration:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const { tenantName, credentialName } = parseArgs(process.argv.slice(2));
const config = loadConfigOrExit();
const logger = createLogger({ level: config.log.level, serviceName: config.service.name, env: config.env });
const pool = createPool(config.database, logger);
const database = createDatabase(pool, logger);

try {
  const tenantRepository = new PostgresTenantRepository(database);
  const credentialRepository = new PostgresApiCredentialRepository(database);
  const auditRecorder = createPostgresAuditEventRecorder(database, logger);
  const credentialService = createApiCredentialService({
    repository: credentialRepository,
    auditRecorder,
    pepper: config.security.apiKeyPepper,
  });

  const tenant = await tenantRepository.create({ name: tenantName });
  // No `actorId` in context: this credential was issued by the bootstrap
  // CLI, not by another API credential — recorded in the audit trail as a
  // "system" actor.
  const issued = await credentialService.issueCredential(tenant.id, { name: credentialName });

  console.log("Tenant created:");
  console.log(`  id:     ${tenant.id}`);
  console.log(`  name:   ${tenant.name}`);
  console.log(`  status: ${tenant.status}`);
  console.log();
  console.log("Credential issued:");
  console.log(`  id:     ${issued.credential.id}`);
  console.log(`  name:   ${issued.credential.name}`);
  console.log(`  prefix: ${issued.credential.keyPrefix}`);
  console.log();
  console.log(`  API key: ${issued.apiKey}`);
  console.log();
  console.log("This key will not be shown again — store it securely now.");
  console.log('Use it as: Authorization: Bearer <the key above>');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await database.close().catch(() => undefined);
}
