import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { TenantRepository } from "../../tenancy/application/tenant-repository.js";
import { AuthenticationError } from "../../../shared/errors/index.js";
import type { ApiCredentialId, TenantId } from "../../../shared/types/index.js";
import { dummyHashFor, verifyApiKeySecret } from "../domain/api-key-hash.js";
import { parseApiKey } from "../domain/api-key.js";
import type { ApiCredentialRepository } from "./api-credential-repository.js";

export interface AuthenticatedIdentity {
  readonly tenantId: TenantId;
  readonly credentialId: ApiCredentialId;
  readonly actorType: "api_key";
  readonly credentialName: string;
}

export interface AuthenticationContext {
  readonly requestId?: string;
  readonly correlationId?: string;
  /** Recorded on failures only, as groundwork for future IP-based throttling — nothing acts on it yet. */
  readonly remoteAddress?: string;
}

export interface AuthenticationService {
  authenticateApiKey(rawKey: string, context?: AuthenticationContext): Promise<AuthenticatedIdentity>;
}

export interface CreateAuthenticationServiceDeps {
  readonly credentialRepository: ApiCredentialRepository;
  readonly tenantRepository: TenantRepository;
  readonly auditRecorder: AuditEventRecorder;
  readonly pepper: string;
}

// Identical for every failure mode on purpose (see section 19 of the Stage 4
// spec): whether the key is malformed, the prefix doesn't exist, the secret
// is wrong, the credential is revoked/expired, or the tenant is
// suspended/deleted, the caller gets the same message. The real reason is
// only ever in the audit trail and structured logs.
const GENERIC_AUTH_FAILURE_MESSAGE = "Invalid or missing authentication credentials";

export function createAuthenticationService(deps: CreateAuthenticationServiceDeps): AuthenticationService {
  const { credentialRepository, tenantRepository, auditRecorder, pepper } = deps;

  async function recordFailure(
    tenantId: TenantId | undefined,
    reason: string,
    context: AuthenticationContext,
  ): Promise<void> {
    await auditRecorder.record({
      ...(tenantId ? { tenantId } : {}),
      eventType: "AUTHENTICATION_FAILURE",
      actorType: "api_key",
      ...(context.requestId ? { requestId: context.requestId } : {}),
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      metadata: { reason, ...(context.remoteAddress ? { remoteAddress: context.remoteAddress } : {}) },
    });
  }

  return {
    async authenticateApiKey(
      rawKey: string,
      context: AuthenticationContext = {},
    ): Promise<AuthenticatedIdentity> {
      const parsed = parseApiKey(rawKey);
      if (!parsed) {
        // No hash comparison to time-match here: a malformed key never
        // reaches the "does this prefix belong to a real credential" branch
        // this function otherwise equalizes the timing of — the sensitive
        // signal is prefix validity, not key-format validity, which an
        // attacker already knows from public documentation regardless.
        await recordFailure(undefined, "malformed_key", context);
        throw new AuthenticationError(GENERIC_AUTH_FAILURE_MESSAGE);
      }

      const credential = await credentialRepository.findByPrefix(parsed.prefix);
      // Always performs a comparison, even when no credential was found —
      // verifying against a dummy hash keeps "prefix not found" and "prefix
      // found but secret wrong" roughly the same shape of work, so a timing
      // measurement can't be used to enumerate which prefixes are real.
      const hashToCompare = credential?.keyHash ?? dummyHashFor(pepper);
      const secretMatches = verifyApiKeySecret(parsed.secret, pepper, hashToCompare);

      if (!credential || !secretMatches) {
        await recordFailure(credential?.tenantId, "invalid_credential", context);
        throw new AuthenticationError(GENERIC_AUTH_FAILURE_MESSAGE);
      }

      if (credential.status !== "ACTIVE") {
        await recordFailure(credential.tenantId, "credential_not_active", context);
        throw new AuthenticationError(GENERIC_AUTH_FAILURE_MESSAGE);
      }

      // Evaluated at request time regardless of `status`, rather than
      // relying solely on a background job to have already flipped a
      // credential to EXPIRED — a credential can be past its expiry before
      // that job next runs.
      if (credential.expiresAt && credential.expiresAt.getTime() <= Date.now()) {
        await recordFailure(credential.tenantId, "credential_expired", context);
        throw new AuthenticationError(GENERIC_AUTH_FAILURE_MESSAGE);
      }

      const tenant = await tenantRepository.findById(credential.tenantId);
      if (!tenant || tenant.status !== "ACTIVE") {
        await recordFailure(credential.tenantId, "tenant_not_active", context);
        throw new AuthenticationError(GENERIC_AUTH_FAILURE_MESSAGE);
      }

      // Best-effort — a failure to record last-used must never fail authentication.
      await credentialRepository.touchLastUsed(credential.id).catch(() => undefined);

      await auditRecorder.record({
        tenantId: tenant.id,
        eventType: "AUTHENTICATION_SUCCESS",
        actorType: "api_key",
        actorId: credential.id,
        ...(context.requestId ? { requestId: context.requestId } : {}),
        ...(context.correlationId ? { correlationId: context.correlationId } : {}),
        metadata: {},
      });

      return {
        tenantId: tenant.id,
        credentialId: credential.id,
        actorType: "api_key",
        credentialName: credential.name,
      };
    },
  };
}
