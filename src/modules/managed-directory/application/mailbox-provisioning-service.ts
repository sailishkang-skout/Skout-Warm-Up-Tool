import type { Database } from "../../../shared/db/index.js";
import { ValidationError } from "../../../shared/errors/index.js";
import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import type { TenantId } from "../../../shared/types/index.js";
import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxOperationalStateService } from "../../mailbox/application/mailbox-operational-state-service.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ManagedDirectoryProvider } from "../domain/managed-directory-provider.js";

export interface ProvisionMailboxInput {
  readonly tenantId: TenantId;
  readonly emailAddress: string;
  readonly provider: Extract<MailboxProviderType, "GMAIL" | "MICROSOFT365">;
  readonly customerDomainId?: string;
  readonly organizationProviderAccountId?: string;
  readonly displayName?: string;
  readonly idempotencyKey: string;
}

export interface MailboxProvisioningService {
  provision(input: ProvisionMailboxInput): Promise<{
    mailboxId: string;
    jobId: string;
    providerResult: "NOT_CONFIGURED" | "SUCCEEDED" | "FAILED";
    errorCode?: string;
  }>;
}

export function createMailboxProvisioningService(deps: {
  readonly database: Database;
  readonly mailboxService: MailboxService;
  readonly auditRecorder: AuditEventRecorder;
  readonly directories: Readonly<Record<"GMAIL" | "MICROSOFT365", ManagedDirectoryProvider>>;
  readonly operationalStates?: MailboxOperationalStateService;
}): MailboxProvisioningService {
  return {
    async provision(input) {
      if (!input.idempotencyKey.trim()) {
        throw new ValidationError("idempotencyKey is required");
      }
      incrementCounter(METRIC.mailboxProvisionAttempt);
      const existing = await deps.database.query<{
        id: string;
        status: string;
        last_error_code: string | null;
      }>(`SELECT id, status, last_error_code FROM mailbox_provisioning_jobs WHERE idempotency_key = $1`, [
        input.idempotencyKey,
      ]);
      if (existing[0]) {
        const mailbox = await findMailbox(deps, input);
        return {
          mailboxId: mailbox?.id ?? "",
          jobId: existing[0].id,
          providerResult: mapJobResult(existing[0].status, existing[0].last_error_code),
          ...(existing[0].last_error_code ? { errorCode: existing[0].last_error_code } : {}),
        };
      }

      const directory = deps.directories[input.provider];
      const providerResult = await directory.createMailbox({
        providerCustomerId: "unconfigured",
        emailAddress: input.emailAddress,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      });

      if (!providerResult.ok) {
        incrementCounter(METRIC.mailboxProvisionFailure);
        const jobRows = await deps.database.query<{ id: string }>(
          `INSERT INTO mailbox_provisioning_jobs (
             tenant_id, customer_domain_id, organization_provider_account_id, email_address, provider,
             status, idempotency_key, last_error_code, attempt_count
           ) VALUES ($1, $2, $3, $4, $5, 'FAILED', $6, $7, 1)
           RETURNING id`,
          [
            input.tenantId,
            input.customerDomainId ?? null,
            input.organizationProviderAccountId ?? null,
            input.emailAddress,
            input.provider,
            input.idempotencyKey,
            providerResult.errorCode ?? "UNKNOWN",
          ],
        );
        return {
          mailboxId: "",
          jobId: jobRows[0]!.id,
          providerResult: providerResult.errorCode === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "FAILED",
          ...(providerResult.errorCode ? { errorCode: providerResult.errorCode } : {}),
        };
      }

      const mailbox = await deps.mailboxService.createMailbox(input.tenantId, {
        emailAddress: input.emailAddress,
        provider: input.provider,
        ...(input.displayName ? { displayName: input.displayName } : {}),
      });
      if (deps.operationalStates) {
        await deps.operationalStates.ensure(input.tenantId, mailbox.id, "PROVISIONED");
      }

      const jobRows = await deps.database.query<{ id: string }>(
        `INSERT INTO mailbox_provisioning_jobs (
           tenant_id, customer_domain_id, organization_provider_account_id, email_address, provider,
           status, idempotency_key, last_error_code, attempt_count, provider_mailbox_id
         ) VALUES ($1, $2, $3, $4, $5, 'SUCCEEDED', $6, NULL, 1, $7)
         RETURNING id`,
        [
          input.tenantId,
          input.customerDomainId ?? null,
          input.organizationProviderAccountId ?? null,
          input.emailAddress,
          input.provider,
          input.idempotencyKey,
          providerResult.value?.providerMailboxId ?? null,
        ],
      );

      incrementCounter(METRIC.mailboxProvisionSuccess);
      await deps.auditRecorder.record({
        tenantId: input.tenantId,
        eventType: "MAILBOX_PROVISIONED",
        actorType: "api_key",
        metadata: { mailboxId: mailbox.id, jobId: jobRows[0]!.id, providerMailboxId: providerResult.value?.providerMailboxId },
      });

      return {
        mailboxId: mailbox.id,
        jobId: jobRows[0]!.id,
        providerResult: "SUCCEEDED",
      };
    },
  };
}

function mapJobResult(status: string, errorCode: string | null): "NOT_CONFIGURED" | "SUCCEEDED" | "FAILED" {
  if (status === "SUCCEEDED") {
    return "SUCCEEDED";
  }
  if (errorCode === "NOT_CONFIGURED") {
    return "NOT_CONFIGURED";
  }
  return "FAILED";
}

async function findMailbox(
  deps: { mailboxService: MailboxService },
  input: ProvisionMailboxInput,
) {
  const listed = await deps.mailboxService.listMailboxes(input.tenantId);
  return listed.find((mailbox) => mailbox.emailAddressCanonical === input.emailAddress.toLowerCase());
}
