import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { ProviderCredentialStore } from "../../providers/application/provider-credential-store.js";
import type { ProviderAccountRepository } from "../../providers/application/provider-account-repository.js";
import type { ProviderRegistry } from "../../providers/application/provider-registry.js";
import type { ProviderAdapter } from "../../providers/domain/provider-adapter.js";
import type { ProviderCapabilities } from "../../providers/domain/provider-capabilities.js";
import type { ProviderCredential } from "../../providers/domain/provider-credential.js";
import { DatabaseError, NotFoundError, ProviderError } from "../../../shared/errors/index.js";
import type { Database, DatabaseClient } from "../../../shared/db/index.js";
import type { MailboxId, ProviderAccountId, TenantId } from "../../../shared/types/index.js";
import { assertValidMailboxTransition } from "../domain/mailbox-lifecycle.js";
import type { Mailbox, MailboxProviderType, MailboxStatus } from "../domain/mailbox.js";
import type { MailboxRepository } from "./mailbox-repository.js";

export interface CreateMailboxInput {
  readonly emailAddress: string;
  readonly provider: MailboxProviderType;
  readonly displayName?: string;
}

/** Safe, non-secret fields only — see src/modules/providers/domain/provider-health.ts for `status`'s meaning. */
export interface ConnectionHealthSnapshot {
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly status: string;
  readonly authenticationStatus: string;
  readonly checkedAt: Date;
  readonly latencyMs?: number;
  readonly sendCapability: boolean;
  readonly receiveCapability: boolean;
  readonly message?: string;
}

/** The mailbox's own connection state plus its provider account's last outcome — never a credential. */
export interface ConnectionSnapshot {
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly mailboxStatus: MailboxStatus;
  readonly enabled: boolean;
  readonly providerAccountStatus: string;
  readonly lastCheckedAt?: Date;
  readonly lastError?: string;
}

/**
 * Safe operational signals only (Stage 6 spec section 17) — deliberately no
 * reputation score and no fabricated data. `mailboxAgeDays` is `null`
 * because no provider integration in this stage exposes an account-creation
 * date safely (Gmail/Graph identity endpoints don't return one without a
 * broader, unjustified scope) — this is an honest gap, not an oversight.
 */
export interface MailboxBaseline {
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly connectionStatus: MailboxStatus;
  readonly authenticationHealth: string;
  readonly sendCapability: boolean;
  readonly receiveCapability: boolean;
  readonly mailboxAgeDays: number | null;
}

export interface MailboxService {
  createMailbox(tenantId: TenantId, input: CreateMailboxInput): Promise<Mailbox>;
  getMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  listMailboxes(tenantId: TenantId): Promise<Mailbox[]>;
  /**
   * Attempts a real connection using whatever credential is currently
   * stored for this mailbox. Throws `ProviderError` (never returns a
   * mailbox claiming CONNECTED) unless the provider adapter genuinely
   * validated the connection. Refreshes a near-expired OAuth credential
   * first when the adapter supports it (see `resolveFreshCredential` below).
   */
  connectMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  disconnectMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  enableMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  disableMailbox(tenantId: TenantId, mailboxId: MailboxId): Promise<Mailbox>;
  getCapabilities(tenantId: TenantId, mailboxId: MailboxId): Promise<ProviderCapabilities>;
  getConnectionSnapshot(tenantId: TenantId, mailboxId: MailboxId): Promise<ConnectionSnapshot>;
  getConnectionHealth(tenantId: TenantId, mailboxId: MailboxId): Promise<ConnectionHealthSnapshot>;
  getBaseline(tenantId: TenantId, mailboxId: MailboxId): Promise<MailboxBaseline>;
}

export interface CreateMailboxServiceDeps {
  readonly database: Database;
  readonly mailboxRepositoryFactory: (db: DatabaseClient) => MailboxRepository;
  readonly providerAccountRepositoryFactory: (db: DatabaseClient) => ProviderAccountRepository;
  readonly providerRegistry: ProviderRegistry;
  readonly credentialStore: ProviderCredentialStore;
  readonly auditRecorder: AuditEventRecorder;
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

// A refresh is attempted once the access token has less than this much
// life left — comfortably longer than a single request/adapter round trip,
// so a credential never goes stale mid-operation.
const REFRESH_BUFFER_MS = 60_000;

/**
 * Token refresh as a provider responsibility (Stage 6 spec section 10):
 * this function only decides *when* to refresh and persists the result —
 * the actual provider-specific token semantics live entirely behind
 * `adapter.oauth.refreshAccessToken`. A credential with no
 * `accessTokenExpiresAt`/`refreshToken` in `secretData` (SMTP/IMAP, or an
 * OAuth grant that never got a refresh token) is returned as-is; there is
 * nothing to refresh.
 *
 * If the refresh token itself is no longer valid, the credential is
 * revoked (not silently retried forever — see spec section 10) and this
 * returns `undefined`, so the caller's normal "no credential" path runs.
 */
async function resolveFreshCredential(
  tenantId: TenantId,
  providerAccountId: ProviderAccountId,
  adapter: ProviderAdapter,
  credentialStore: ProviderCredentialStore,
  auditRecorder: AuditEventRecorder,
): Promise<ProviderCredential | undefined> {
  const credential = await credentialStore.getCredential(providerAccountId);
  if (!credential || !adapter.oauth) {
    return credential;
  }

  const expiresAtRaw = credential.secretData.accessTokenExpiresAt;
  const refreshToken = credential.secretData.refreshToken;
  if (typeof expiresAtRaw !== "string" || typeof refreshToken !== "string") {
    return credential;
  }

  const expiresAtMs = Date.parse(expiresAtRaw);
  if (Number.isNaN(expiresAtMs) || expiresAtMs - Date.now() > REFRESH_BUFFER_MS) {
    return credential;
  }

  try {
    const refreshed = await adapter.oauth.refreshAccessToken(refreshToken);
    const updated: ProviderCredential = {
      ...credential,
      secretData: {
        ...credential.secretData,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? refreshToken,
        scope: refreshed.scope,
        accessTokenExpiresAt: refreshed.expiresAt.toISOString(),
      },
    };
    await credentialStore.saveCredential(updated);
    return updated;
  } catch {
    // The refresh token itself is no longer valid — never silently retried
    // forever (Stage 6 spec section 10). Revoking here, rather than leaving
    // a dead credential ACTIVE, means the next connection attempt fails
    // closed instead of repeatedly trying the same broken token.
    await credentialStore.revokeCredential(providerAccountId);
    await auditRecorder.record({
      tenantId,
      eventType: "PROVIDER_CREDENTIAL_REVOKED",
      actorType: "system",
      metadata: { providerAccountId, reason: "refresh_failed" },
    });
    return undefined;
  }
}

export function createMailboxService(deps: CreateMailboxServiceDeps): MailboxService {
  const {
    database,
    mailboxRepositoryFactory,
    providerAccountRepositoryFactory,
    providerRegistry,
    credentialStore,
    auditRecorder,
  } = deps;

  return {
    // Mailbox + its provider account are created together, atomically:
    // "every mailbox has exactly one provider account" is a structural
    // invariant (see provider_accounts_mailbox_unique), not just a
    // convention — a mailbox left without one after a partial failure
    // would violate the architectural model this stage establishes.
    async createMailbox(tenantId: TenantId, input: CreateMailboxInput): Promise<Mailbox> {
      const mailbox = await database.withTransaction(async (tx) => {
        const mailboxRepository = mailboxRepositoryFactory(tx);
        const providerAccountRepository = providerAccountRepositoryFactory(tx);

        const created = await mailboxRepository.create({
          tenantId,
          emailAddress: input.emailAddress,
          provider: input.provider,
          ...(input.displayName ? { displayName: input.displayName } : {}),
        });

        await providerAccountRepository.create({
          tenantId,
          mailboxId: created.id,
          provider: input.provider,
        });

        return created;
      });

      await auditRecorder.record({
        tenantId,
        eventType: "MAILBOX_CREATED",
        actorType: "system",
        metadata: { mailboxId: mailbox.id, provider: mailbox.provider },
      });

      return mailbox;
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
      const credential = providerAccount
        ? await resolveFreshCredential(tenantId, providerAccount.id, adapter, credentialStore, auditRecorder)
        : undefined;

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
      const updated = assertUpdated(
        await mailboxRepository.updateStatus(tenantId, mailboxId, "DISCONNECTED"),
        "mailbox disconnect",
      );

      // Deliberately does not revoke the stored credential — disconnect is
      // a mailbox-level operational state, not a credential lifecycle event
      // (Stage 6 spec section 3: a credential can remain ACTIVE while its
      // mailbox is DISCONNECTED). Revocation is a separate, explicit action.
      await auditRecorder.record({
        tenantId,
        eventType: "MAILBOX_DISCONNECTED",
        actorType: "system",
        metadata: { mailboxId, provider: mailbox.provider },
      });

      return updated;
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

    async getConnectionSnapshot(tenantId: TenantId, mailboxId: MailboxId): Promise<ConnectionSnapshot> {
      const mailbox = await getMailboxOrThrow(mailboxRepositoryFactory(database), tenantId, mailboxId);
      const providerAccount = await providerAccountRepositoryFactory(database).findByMailboxId(tenantId, mailboxId);

      return {
        mailboxId: mailbox.id,
        provider: mailbox.provider,
        mailboxStatus: mailbox.status,
        enabled: mailbox.enabled,
        providerAccountStatus: providerAccount?.status ?? "PENDING",
        ...(providerAccount?.lastCheckedAt ? { lastCheckedAt: providerAccount.lastCheckedAt } : {}),
        ...(providerAccount?.lastError ? { lastError: providerAccount.lastError } : {}),
      };
    },

    async getConnectionHealth(tenantId: TenantId, mailboxId: MailboxId): Promise<ConnectionHealthSnapshot> {
      const mailbox = await getMailboxOrThrow(mailboxRepositoryFactory(database), tenantId, mailboxId);
      const adapter = providerRegistry.resolve(mailbox.provider);
      const providerAccount = await providerAccountRepositoryFactory(database).findByMailboxId(tenantId, mailboxId);
      const credential = providerAccount
        ? await resolveFreshCredential(tenantId, providerAccount.id, adapter, credentialStore, auditRecorder)
        : undefined;

      const health = await adapter.getConnectionHealth(credential);
      const capabilities = adapter.getCapabilities();
      const isHealthy = health.status === "HEALTHY";

      return {
        mailboxId,
        provider: mailbox.provider,
        status: health.status,
        authenticationStatus: health.status,
        checkedAt: health.checkedAt,
        ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}),
        // Reflects whether this mailbox could actually send/receive right
        // now, not just whether the provider type supports it in
        // principle — a provider-level capability with no healthy
        // connection behind it is not a usable capability yet.
        sendCapability: capabilities.canSend && isHealthy,
        receiveCapability: capabilities.canReceive && isHealthy,
        ...(health.message ? { message: health.message } : {}),
      };
    },

    async getBaseline(tenantId: TenantId, mailboxId: MailboxId): Promise<MailboxBaseline> {
      const mailbox = await getMailboxOrThrow(mailboxRepositoryFactory(database), tenantId, mailboxId);
      const adapter = providerRegistry.resolve(mailbox.provider);
      const providerAccount = await providerAccountRepositoryFactory(database).findByMailboxId(tenantId, mailboxId);
      const credential = providerAccount
        ? await resolveFreshCredential(tenantId, providerAccount.id, adapter, credentialStore, auditRecorder)
        : undefined;

      const health = await adapter.getConnectionHealth(credential);
      const capabilities = adapter.getCapabilities();
      const isHealthy = health.status === "HEALTHY";

      return {
        mailboxId,
        provider: mailbox.provider,
        connectionStatus: mailbox.status,
        authenticationHealth: health.status,
        sendCapability: capabilities.canSend && isHealthy,
        receiveCapability: capabilities.canReceive && isHealthy,
        mailboxAgeDays: null,
      };
    },
  };
}
