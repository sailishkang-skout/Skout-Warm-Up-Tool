import type { AuditEventRecorder, RecordAuditEventInput } from "../../audit/application/audit-event-recorder.js";
import { NotFoundError } from "../../../shared/errors/index.js";
import type { ApiCredentialId, TenantId } from "../../../shared/types/index.js";
import { generateApiKey } from "../domain/api-key.js";
import { hashApiKeySecret } from "../domain/api-key-hash.js";
import type { ApiCredential } from "../domain/api-credential.js";
import type { ApiCredentialRepository } from "./api-credential-repository.js";

export interface IssueCredentialInput {
  readonly name: string;
  readonly expiresAt?: Date;
  readonly privilege?: import("../domain/api-credential-privilege.js").ApiCredentialPrivilege;
}

export interface IssuedApiCredential {
  readonly credential: ApiCredential;
  /** The complete API key. Shown/returned exactly once — never persisted, never logged. */
  readonly apiKey: string;
}

/** Who/what triggered a credential-management action, for the audit trail. Omit `actorId` for CLI/system-initiated actions. */
export interface AuditActorContext {
  readonly actorId?: ApiCredentialId;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface ApiCredentialService {
  issueCredential(tenantId: TenantId, input: IssueCredentialInput, context?: AuditActorContext): Promise<IssuedApiCredential>;
  /**
   * Issues a new credential and leaves the old one untouched and ACTIVE —
   * rotation never implicitly revokes. The caller must explicitly call
   * `revokeCredential` on the old id once it's confirmed the new key is
   * deployed everywhere it needs to be. This is the safer default: an
   * implicit revoke-on-rotate risks locking a tenant out mid-deploy with no
   * recovery path other than the bootstrap CLI.
   */
  rotateCredential(tenantId: TenantId, credentialId: ApiCredentialId, context?: AuditActorContext): Promise<IssuedApiCredential>;
  revokeCredential(tenantId: TenantId, credentialId: ApiCredentialId, context?: AuditActorContext): Promise<ApiCredential>;
  listCredentials(tenantId: TenantId): Promise<ApiCredential[]>;
}

export interface CreateApiCredentialServiceDeps {
  readonly repository: ApiCredentialRepository;
  readonly auditRecorder: AuditEventRecorder;
  readonly pepper: string;
}

function auditActorFields(
  context: AuditActorContext,
): Pick<RecordAuditEventInput, "actorType" | "actorId" | "requestId" | "correlationId"> {
  return {
    actorType: context.actorId ? "api_key" : "system",
    ...(context.actorId ? { actorId: context.actorId } : {}),
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(context.correlationId ? { correlationId: context.correlationId } : {}),
  };
}

export function createApiCredentialService(deps: CreateApiCredentialServiceDeps): ApiCredentialService {
  const { repository, auditRecorder, pepper } = deps;

  async function issueCredential(
    tenantId: TenantId,
    input: IssueCredentialInput,
    context: AuditActorContext = {},
  ): Promise<IssuedApiCredential> {
    const generated = generateApiKey();
    const keyHash = hashApiKeySecret(generated.secret, pepper);

    const credential = await repository.create({
      tenantId,
      name: input.name,
      keyPrefix: generated.prefix,
      keyHash,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      ...(input.privilege ? { privilege: input.privilege } : {}),
    });

    await auditRecorder.record({
      tenantId,
      eventType: "API_KEY_CREATED",
      ...auditActorFields(context),
      // Key deliberately `id`, not `credentialId` — sanitizeForLogging
      // redacts any key *containing* "credential" (by design, to catch a
      // stray `credentials: {...}` bag of secrets), which would otherwise
      // silently blank out this non-secret id reference before it reaches
      // the audit_events row.
      metadata: { id: credential.id, name: credential.name },
    });

    return { credential, apiKey: generated.fullKey };
  }

  async function rotateCredential(
    tenantId: TenantId,
    credentialId: ApiCredentialId,
    context: AuditActorContext = {},
  ): Promise<IssuedApiCredential> {
    const existing = await repository.findById(tenantId, credentialId);
    if (!existing) {
      throw new NotFoundError("API credential", credentialId);
    }

    const issued = await issueCredential(
      tenantId,
      { name: existing.name, ...(existing.expiresAt ? { expiresAt: existing.expiresAt } : {}) },
      context,
    );

    await auditRecorder.record({
      tenantId,
      eventType: "API_KEY_ROTATED",
      ...auditActorFields(context),
      metadata: { previousId: existing.id, newId: issued.credential.id },
    });

    return issued;
  }

  async function revokeCredential(
    tenantId: TenantId,
    credentialId: ApiCredentialId,
    context: AuditActorContext = {},
  ): Promise<ApiCredential> {
    const revoked = await repository.revoke(tenantId, credentialId);
    if (!revoked) {
      throw new NotFoundError("API credential", credentialId);
    }

    await auditRecorder.record({
      tenantId,
      eventType: "API_KEY_REVOKED",
      ...auditActorFields(context),
      metadata: { id: revoked.id },
    });

    return revoked;
  }

  function listCredentials(tenantId: TenantId): Promise<ApiCredential[]> {
    return repository.listByTenant(tenantId);
  }

  return { issueCredential, rotateCredential, revokeCredential, listCredentials };
}
