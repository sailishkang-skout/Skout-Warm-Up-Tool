import type { AuditEventRecorder, RecordAuditEventInput } from "../../audit/application/audit-event-recorder.js";
import type { MailboxRepository } from "../../mailbox/application/mailbox-repository.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import { canonicalizeEmailAddress } from "../../mailbox/domain/email-canonicalization.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { ProviderAccountRepository } from "../../providers/application/provider-account-repository.js";
import type { ProviderCredentialStore } from "../../providers/application/provider-credential-store.js";
import type { ProviderRegistry } from "../../providers/application/provider-registry.js";
import type { ProviderCredential, ProviderCredentialKind } from "../../providers/domain/provider-credential.js";
import { ConfigurationError, InternalError, NotFoundError, OAuthError, ProviderIdentityMismatchError, ValidationError } from "../../../shared/errors/index.js";
import type { ConnectionAttemptRepository } from "./connection-attempt-repository.js";
import type { OAuthConnectionLock } from "./oauth-connection-lock.js";
import type { OAuthStateStore } from "./oauth-state-store.js";
import { generatePkcePair } from "../domain/pkce.js";

/** The two `MailboxProviderType` values that currently support an OAuth flow — see ../../providers/README.md. */
export type OAuthCapableProviderType = "GMAIL" | "MICROSOFT365";

const CREDENTIAL_KIND_BY_PROVIDER: Record<OAuthCapableProviderType, ProviderCredentialKind> = {
  GMAIL: "GOOGLE_OAUTH",
  MICROSOFT365: "MICROSOFT_OAUTH",
};

export interface OAuthRequestContext {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly actorId?: string;
}

export interface InitiateOAuthResult {
  readonly authorizationUrl: string;
}

export interface OAuthCallbackParams {
  // `| undefined` (not just optional) so a zod-parsed query object — where
  // an absent field is still a present key typed `T | undefined` under
  // exactOptionalPropertyTypes — is directly assignable without callers
  // needing to strip undefined keys first.
  readonly state?: string | undefined;
  readonly code?: string | undefined;
  readonly error?: string | undefined;
}

export interface OAuthCallbackResult {
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly status: string;
}

export interface OAuthConnectionService {
  initiate(
    tenantId: TenantId,
    mailboxId: MailboxId,
    provider: OAuthCapableProviderType,
    context?: OAuthRequestContext,
  ): Promise<InitiateOAuthResult>;
  handleCallback(
    provider: OAuthCapableProviderType,
    params: OAuthCallbackParams,
    context?: OAuthRequestContext,
  ): Promise<OAuthCallbackResult>;
}

export interface CreateOAuthConnectionServiceDeps {
  readonly mailboxRepository: MailboxRepository;
  readonly providerAccountRepository: ProviderAccountRepository;
  readonly providerRegistry: ProviderRegistry;
  readonly credentialStore: ProviderCredentialStore;
  readonly stateStore: OAuthStateStore;
  readonly connectionLock: OAuthConnectionLock;
  readonly connectionAttemptRepository: ConnectionAttemptRepository;
  readonly auditRecorder: AuditEventRecorder;
  readonly mailboxService: MailboxService;
}

function contextFields(
  context: OAuthRequestContext,
): Pick<RecordAuditEventInput, "requestId" | "correlationId"> {
  return {
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
  };
}

/**
 * Orchestrates the OAuth authorization-code + PKCE flow for Gmail/Microsoft
 * 365 across state, locking, token exchange, mandatory identity validation,
 * encrypted credential storage, and the final mailbox connection attempt —
 * see this module's README for the full flow diagram and the security
 * invariants each step enforces (Stage 6 spec sections 4-8, 11, 14).
 *
 * Every failure path is generic to the caller ("Invalid or expired
 * connection request" / "Authorization was denied or could not be
 * completed") — the real reason only ever reaches the audit trail and
 * structured logs, never the HTTP response (Stage 6 spec section 14: "do
 * not reveal internal state information to the caller").
 */
export function createOAuthConnectionService(deps: CreateOAuthConnectionServiceDeps): OAuthConnectionService {
  const {
    mailboxRepository,
    providerAccountRepository,
    providerRegistry,
    credentialStore,
    stateStore,
    connectionLock,
    connectionAttemptRepository,
    auditRecorder,
    mailboxService,
  } = deps;

  async function initiate(
    tenantId: TenantId,
    mailboxId: MailboxId,
    provider: OAuthCapableProviderType,
    context: OAuthRequestContext = {},
  ): Promise<InitiateOAuthResult> {
    const mailbox = await mailboxRepository.findById(tenantId, mailboxId);
    if (!mailbox) {
      throw new NotFoundError("Mailbox", mailboxId);
    }
    if (mailbox.provider !== provider) {
      throw new ValidationError(`Mailbox provider is '${mailbox.provider}', not '${provider}'`);
    }

    const adapter = providerRegistry.resolve(provider);
    if (adapter.getConfigurationStatus() !== "CONFIGURED" || !adapter.oauth) {
      throw new ConfigurationError(`OAuth is not configured for provider '${provider}' on this deployment`);
    }

    const acquired = await connectionLock.acquire(mailboxId);
    if (!acquired) {
      throw new ValidationError("A connection attempt is already in progress for this mailbox");
    }

    try {
      const { codeVerifier, codeChallenge } = generatePkcePair();
      const { state } = await stateStore.create({ tenantId, mailboxId, provider, codeVerifier });

      await connectionAttemptRepository.create({
        tenantId,
        mailboxId,
        provider,
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      });

      await auditRecorder.record({
        tenantId,
        eventType: "MAILBOX_CONNECTION_STARTED",
        actorType: context.actorId ? "api_key" : "system",
        metadata: { mailboxId, provider },
        ...contextFields(context),
      });

      const authorizationUrl = adapter.oauth.getAuthorizationUrl({ state, codeChallenge });
      return { authorizationUrl };
    } catch (error) {
      await connectionLock.release(mailboxId);
      throw error;
    }
  }

  async function handleCallback(
    provider: OAuthCapableProviderType,
    params: OAuthCallbackParams,
    context: OAuthRequestContext = {},
  ): Promise<OAuthCallbackResult> {
    if (!params.state) {
      throw new ValidationError("Missing OAuth state parameter");
    }

    const record = await stateStore.consume(params.state);
    if (!record) {
      // Indistinguishable from here whether this is expiry, a genuine
      // replay, or a forged token — all three are equally suspicious and
      // handled identically, both in the audit trail and the response.
      await auditRecorder.record({
        eventType: "OAUTH_STATE_REPLAY_DETECTED",
        actorType: "system",
        metadata: { provider },
        ...contextFields(context),
      });
      throw new OAuthError("Invalid or expired connection request");
    }

    const attempt = await connectionAttemptRepository.findActiveByMailbox(record.tenantId, record.mailboxId);

    // Arrow function, not a function declaration: keeps `record`'s
    // narrowing (non-undefined, established by the check above) intact
    // inside this closure.
    const recordFailure = async (reason: string, metadata: Record<string, unknown> = {}): Promise<void> => {
      if (attempt) {
        await connectionAttemptRepository.updateStatus(attempt.id, {
          status: "FAILED",
          failureReason: reason,
          completed: true,
        });
      }
      await auditRecorder.record({
        tenantId: record.tenantId,
        eventType: "MAILBOX_CONNECTION_FAILED",
        actorType: "system",
        metadata: { mailboxId: record.mailboxId, provider: record.provider, reason, ...metadata },
        ...contextFields(context),
      });
      await connectionLock.release(record.mailboxId);
    };

    if (params.error) {
      await recordFailure("provider_denied", { providerError: params.error });
      throw new OAuthError("Authorization was denied or could not be completed");
    }

    if (record.provider !== provider) {
      await recordFailure("provider_mismatch");
      throw new OAuthError("Invalid or expired connection request");
    }

    if (!params.code) {
      await recordFailure("missing_code");
      throw new OAuthError("Invalid or expired connection request");
    }

    const mailbox = await mailboxRepository.findById(record.tenantId, record.mailboxId);
    if (!mailbox) {
      await recordFailure("mailbox_not_found");
      throw new OAuthError("Invalid or expired connection request");
    }

    const providerAccount = await providerAccountRepository.findByMailboxId(record.tenantId, record.mailboxId);
    if (!providerAccount) {
      await recordFailure("provider_account_missing");
      throw new InternalError("Mailbox is missing its provider account");
    }

    const adapter = providerRegistry.resolve(record.provider);
    if (!adapter.oauth) {
      await recordFailure("oauth_not_supported");
      throw new ConfigurationError(`No OAuth support registered for provider '${record.provider}'`);
    }

    if (attempt) {
      await connectionAttemptRepository.updateStatus(attempt.id, { status: "AUTHORIZED" });
    }

    let tokenSet;
    try {
      tokenSet = await adapter.oauth.exchangeCodeForTokens({ code: params.code, codeVerifier: record.codeVerifier });
    } catch (error) {
      await recordFailure("token_exchange_failed");
      throw error;
    }

    const credential: ProviderCredential = {
      providerAccountId: providerAccount.id,
      kind: CREDENTIAL_KIND_BY_PROVIDER[provider],
      secretData: {
        accessToken: tokenSet.accessToken,
        ...(tokenSet.refreshToken ? { refreshToken: tokenSet.refreshToken } : {}),
        scope: tokenSet.scope,
        accessTokenExpiresAt: tokenSet.expiresAt.toISOString(),
      },
      // No fixed expiry when a refresh token was issued — the credential
      // renews indefinitely via oauth.refreshAccessToken. Without one,
      // this credential can never be refreshed, so it expires exactly when
      // the access token does.
      ...(tokenSet.refreshToken ? {} : { expiresAt: tokenSet.expiresAt }),
    };

    let identity;
    try {
      identity = await adapter.getMailboxIdentity(credential);
    } catch (error) {
      await recordFailure("identity_check_failed");
      throw error;
    }

    // Mandatory security invariant (Stage 6 spec section 7): the identity
    // OAuth actually authenticated must match the mailbox being connected.
    // The credential is never persisted on a mismatch — discarded once this
    // function returns, never touching the credential store.
    if (canonicalizeEmailAddress(identity.emailAddress) !== mailbox.emailAddressCanonical) {
      await recordFailure("identity_mismatch", { requestedEmail: mailbox.emailAddressCanonical });
      throw new ProviderIdentityMismatchError(
        "The account that completed authorization does not match the mailbox being connected",
      );
    }

    await credentialStore.saveCredential(credential);
    await auditRecorder.record({
      tenantId: record.tenantId,
      eventType: "PROVIDER_CREDENTIAL_CREATED",
      actorType: "system",
      metadata: { providerAccountId: providerAccount.id, credentialType: credential.kind },
      ...contextFields(context),
    });

    if (attempt) {
      await connectionAttemptRepository.updateStatus(attempt.id, { status: "VALIDATING" });
    }

    try {
      const connected = await mailboxService.connectMailbox(record.tenantId, record.mailboxId);
      if (attempt) {
        await connectionAttemptRepository.updateStatus(attempt.id, { status: "SUCCEEDED", completed: true });
      }
      await auditRecorder.record({
        tenantId: record.tenantId,
        eventType: "MAILBOX_CONNECTION_SUCCEEDED",
        actorType: "system",
        metadata: { mailboxId: record.mailboxId, provider: record.provider },
        ...contextFields(context),
      });
      await connectionLock.release(record.mailboxId);
      return { mailboxId: connected.id, provider: connected.provider, status: connected.status };
    } catch (error) {
      await recordFailure("connection_validation_failed");
      throw error;
    }
  }

  return { initiate, handleCallback };
}
