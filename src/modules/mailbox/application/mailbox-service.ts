import type { ProviderCredentialStore } from "../../providers/application/provider-credential-store.js";
import type { ProviderAccountRepository } from "../../providers/application/provider-account-repository.js";
import type { ProviderRegistry } from "../../providers/application/provider-registry.js";
import type { ProviderCapabilities } from "../../providers/domain/provider-capabilities.js";
import { DatabaseError, NotFoundError, ProviderError } from "../../../shared/errors/index.js";
import type { Database, DatabaseClient } from "../../../shared/db/index.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import { assertValidMailboxTransition } from "../domain/mailbox-lifecycle.js";
import type { Mailbox, MailboxProviderType } from "../domain/mailbox.js";
import type { MailboxRepository } from "./mailbox-repository.js";

export interface CreateMailboxInput {
  readonly emailAddress: string;
  readonly provider: MailboxProviderType;
  readonly displayName?: string;
}

export interface MailboxService {
  createMailbox(tenantId: TenantId, input: CreateMailboxInput): Promise<Mailbox>;
  getMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  listMailboxes(tenantId: TenantId): Promise<Mailbox[]>;
  /**
   * Attempts a real connection. Throws `ProviderError` (never returns a
   * mailbox claiming CONNECTED) unless the provider adapter genuinely
   * validated the connection — which no Stage 5 adapter can do yet, since
   * none has real OAuth/SMTP/IMAP behind it.
   */
  connectMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  disconnectMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  enableMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  disableMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  getCapabilities(tenantId: TenantId, mailboxId: MailboxId): Promise<ProviderCapabilities>;
}

export interface CreateMailboxServiceDeps {
  readonly database: Database;
  readonly mailboxRepositoryFactory: (db: DatabaseClient) => MailboxRepository;
  readonly providerAccountRepositoryFactory: (db: DatabaseClient) => ProviderAccountRepository;
  readonly providerRegistry: ProviderRegistry;
  readonly credentialStore: ProviderCredentialStore;
}

async function getMailboxOrThrow(
  repository: MailboxRepository,
  tenantId: TenantId,
  mailboxId: MailboxId,
): Promise<Mailbox> {
  const mailbox = await repository.findById(tenantId, mailboxId);
  if (!mailbox) {
    throw new NotFoundError("Mailbox", mailboxId);
  }
  return mailbox;
}

function assertUpdated<T>(value: T | undefined, context: string): T {
  if (value === undefined) {
    throw new DatabaseError(`Expected ${context} to update a row, but found none`);
  }
  return value;
}

export function createMailboxService(deps: CreateMailboxServiceDeps): MailboxService {
  const { database, mailboxRepositoryFactory, providerAccountRepositoryFactory, providerRegistry, credentialStore } =
    deps;

  return {
    // Mailbox + its provider account are created together, atomically:
    // "every mailbox has exactly one provider account" is a structural
    // invariant (see provider_accounts_mailbox_unique), not just a
    // convention — a mailbox left without one after a partial failure
    // would violate the architectural model this stage establishes.
    async createMailbox(tenantId: TenantId, input: CreateMailboxInput): Promise<Mailbox> {
      return database.withTransaction(async (tx) => {
        const mailboxRepository = mailboxRepositoryFactory(tx);
        const providerAccountRepository = providerAccountRepositoryFactory(tx);

        const mailbox = await mailboxRepository.create({
          tenantId,
          emailAddress: input.emailAddress,
          provider: input.provider,
          ...(input.displayName ? { displayName: input.displayName } : {}),
        });

        await providerAccountRepository.create({
          tenantId,
          mailboxId: mailbox.id,
          provider: input.provider,
        });

        return mailbox;
      });
    },

    async getMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox> {
      return getMailboxOrThrow(mailboxRepositoryFactory(database), tenantId, mailboxId);
    },

    async listMailboxes(tenantId: TenantId): Promise<Mailbox[]> {
      return mailboxRepositoryFactory(database).listByTenant(tenantId);
    },

    async connectMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox> {
      const mailboxRepository = mailboxRepositoryFactory(database);
      const providerAccountRepository = providerAccountRepositoryFactory(database);
      const mailbox = await getMailboxOrThrow(mailboxRepository, tenantId, mailboxId);

      // Idempotent: already connected or an attempt is already in flight —
      // nothing more for this call to do.
      if (mailbox.status === "CONNECTED" || mailbox.status === "CONNECTING") {
        return mailbox;
      }

      assertValidMailboxTransition(mailbox.status, "CONNECTING");
      await mailboxRepository.updateStatus(tenantId, mailboxId, "CONNECTING");

      const adapter = providerRegistry.resolve(mailbox.provider);
      const providerAccount = await providerAccountRepository.findByMailboxId(tenantId, mailboxId);
      const credential = providerAccount ? await credentialStore.getCredential(providerAccount.id) : undefined;

      const validation = await adapter.validateConnection(credential);

      if (providerAccount) {
        await providerAccountRepository.updateConnectionOutcome(tenantId, mailboxId, {
          status: validation.status === "VALID" ? "ACTIVE" : "ERROR",
          lastCheckedAt: validation.checkedAt,
          ...(validation.status === "VALID" ? {} : { lastError: validation.message }),
        });
      }

      if (validation.status !== "VALID") {
        await mailboxRepository.updateStatus(tenantId, mailboxId, "ERROR");
        // Never a fabricated CONNECTED state — the caller gets a real
        // typed error explaining why, matching `validation.status`:
        // NOT_CONFIGURED / INVALID_CREDENTIAL / PROVIDER_ERROR all surface
        // as ProviderError, distinguished by `retryable` and the message.
        throw new ProviderError(mailbox.provider, validation.message, {
          retryable: validation.status === "PROVIDER_ERROR",
          details: { validationStatus: validation.status },
        });
      }

      const connected = await mailboxRepository.updateStatus(tenantId, mailboxId, "CONNECTED");
      return assertUpdated(connected, "mailbox connect");
    },

    async disconnectMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox> {
      const mailboxRepository = mailboxRepositoryFactory(database);
      const mailbox = await getMailboxOrThrow(mailboxRepository, tenantId, mailboxId);

      if (mailbox.status === "DISCONNECTED") {
        return mailbox; // idempotent
      }

      assertValidMailboxTransition(mailbox.status, "DISCONNECTED");
      const updated = await mailboxRepository.updateStatus(tenantId, mailboxId, "DISCONNECTED");
      return assertUpdated(updated, "mailbox disconnect");
    },

    async enableMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox> {
      const mailboxRepository = mailboxRepositoryFactory(database);
      const mailbox = await getMailboxOrThrow(mailboxRepository, tenantId, mailboxId);

      if (mailbox.enabled) {
        return mailbox; // idempotent
      }
      const updated = await mailboxRepository.updateEnabled(tenantId, mailboxId, true);
      return assertUpdated(updated, "mailbox enable");
    },

    async disableMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox> {
      const mailboxRepository = mailboxRepositoryFactory(database);
      const mailbox = await getMailboxOrThrow(mailboxRepository, tenantId, mailboxId);

      if (!mailbox.enabled) {
        return mailbox; // idempotent
      }
      const updated = await mailboxRepository.updateEnabled(tenantId, mailboxId, false);
      return assertUpdated(updated, "mailbox disable");
    },

    async getCapabilities(tenantId: TenantId, mailboxId: MailboxId): Promise<ProviderCapabilities> {
      const mailbox = await getMailboxOrThrow(mailboxRepositoryFactory(database), tenantId, mailboxId);
      return providerRegistry.resolve(mailbox.provider).getCapabilities();
    },
  };
}
