import { describe, expect, it } from "vitest";
import { createAuthenticationService } from "../../src/modules/auth/application/authentication-service.js";
import { generateApiKey } from "../../src/modules/auth/domain/api-key.js";
import { hashApiKeySecret } from "../../src/modules/auth/domain/api-key-hash.js";
import { AuthenticationError } from "../../src/shared/errors/index.js";
import { createFakeApiCredentialRepository } from "../support/fake-api-credential-repository.js";
import { createFakeAuditEventRecorder } from "../support/fake-audit-event-recorder.js";
import { createFakeTenantRepository } from "../support/fake-tenant-repository.js";

const PEPPER = "test-pepper-value-with-enough-length-32";

function setup() {
  const credentialRepository = createFakeApiCredentialRepository();
  const tenantRepository = createFakeTenantRepository();
  const auditRecorder = createFakeAuditEventRecorder();
  const authService = createAuthenticationService({
    credentialRepository,
    tenantRepository,
    auditRecorder,
    pepper: PEPPER,
  });
  return { credentialRepository, tenantRepository, auditRecorder, authService };
}

type Deps = ReturnType<typeof setup>;

function seedActiveCredential(deps: Deps, overrides: { status?: "ACTIVE" | "REVOKED" | "EXPIRED"; expiresAt?: Date } = {}) {
  const tenant = deps.tenantRepository.seed({ name: "Acme" });
  const generated = generateApiKey();
  const credential = deps.credentialRepository.seed({
    tenantId: tenant.id,
    keyPrefix: generated.prefix,
    keyHash: hashApiKeySecret(generated.secret, PEPPER),
    ...overrides,
  });
  return { tenant, credential, fullKey: generated.fullKey };
}

async function captureMessage(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error instanceof AuthenticationError ? error.message : undefined;
  }
}

describe("authenticateApiKey", () => {
  it("returns the authenticated identity for a valid key", async () => {
    const deps = setup();
    const { tenant, credential, fullKey } = seedActiveCredential(deps);

    const identity = await deps.authService.authenticateApiKey(fullKey);

    expect(identity).toEqual({
      tenantId: tenant.id,
      credentialId: credential.id,
      actorType: "api_key",
      credentialName: credential.name,
      privilege: "TENANT",
    });
  });

  it("records AUTHENTICATION_SUCCESS and touches last-used on success", async () => {
    const deps = setup();
    const { credential, fullKey } = seedActiveCredential(deps);

    await deps.authService.authenticateApiKey(fullKey);

    expect(deps.credentialRepository.touchedLastUsedIds).toEqual([credential.id]);
    const successEvents = deps.auditRecorder.events.filter((event) => event.eventType === "AUTHENTICATION_SUCCESS");
    expect(successEvents).toHaveLength(1);
    expect(successEvents[0]).toMatchObject({ tenantId: credential.tenantId, actorId: credential.id });
  });

  it("rejects a malformed key", async () => {
    const deps = setup();
    await expect(deps.authService.authenticateApiKey("not-a-real-key")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects an unknown prefix", async () => {
    const deps = setup();
    const generated = generateApiKey();
    await expect(deps.authService.authenticateApiKey(generated.fullKey)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("rejects the correct prefix with the wrong secret", async () => {
    const deps = setup();
    const { fullKey } = seedActiveCredential(deps);
    const tamperedKey = fullKey.slice(0, -1) + (fullKey.endsWith("A") ? "B" : "A");
    await expect(deps.authService.authenticateApiKey(tamperedKey)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a revoked credential", async () => {
    const deps = setup();
    const { fullKey } = seedActiveCredential(deps, { status: "REVOKED" });
    await expect(deps.authService.authenticateApiKey(fullKey)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects an expired credential even if status still says ACTIVE (evaluated at request time)", async () => {
    const deps = setup();
    const { fullKey } = seedActiveCredential(deps, { status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) });
    await expect(deps.authService.authenticateApiKey(fullKey)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("accepts a credential with a future expiry", async () => {
    const deps = setup();
    const { fullKey } = seedActiveCredential(deps, { expiresAt: new Date(Date.now() + 1000 * 60 * 60) });
    await expect(deps.authService.authenticateApiKey(fullKey)).resolves.toBeDefined();
  });

  it("rejects a credential belonging to a suspended tenant", async () => {
    const deps = setup();
    const tenant = deps.tenantRepository.seed({ name: "Suspended Co", status: "SUSPENDED" });
    const generated = generateApiKey();
    deps.credentialRepository.seed({
      tenantId: tenant.id,
      keyPrefix: generated.prefix,
      keyHash: hashApiKeySecret(generated.secret, PEPPER),
    });
    await expect(deps.authService.authenticateApiKey(generated.fullKey)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("rejects a credential belonging to a deleted tenant", async () => {
    const deps = setup();
    const tenant = deps.tenantRepository.seed({ name: "Deleted Co", status: "DELETED" });
    const generated = generateApiKey();
    deps.credentialRepository.seed({
      tenantId: tenant.id,
      keyPrefix: generated.prefix,
      keyHash: hashApiKeySecret(generated.secret, PEPPER),
    });
    await expect(deps.authService.authenticateApiKey(generated.fullKey)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("gives byte-identical error messages across every failure mode (no enumeration signal)", async () => {
    const deps = setup();
    const { fullKey: revokedKey } = seedActiveCredential(deps, { status: "REVOKED" });
    const suspendedTenant = deps.tenantRepository.seed({ name: "Suspended", status: "SUSPENDED" });
    const suspendedKey = generateApiKey();
    deps.credentialRepository.seed({
      tenantId: suspendedTenant.id,
      keyPrefix: suspendedKey.prefix,
      keyHash: hashApiKeySecret(suspendedKey.secret, PEPPER),
    });

    const messages = await Promise.all([
      captureMessage(() => deps.authService.authenticateApiKey("garbage")),
      captureMessage(() => deps.authService.authenticateApiKey(generateApiKey().fullKey)),
      captureMessage(() => deps.authService.authenticateApiKey(revokedKey)),
      captureMessage(() => deps.authService.authenticateApiKey(suspendedKey.fullKey)),
    ]);

    expect(messages[0]).toBeDefined();
    expect(new Set(messages).size).toBe(1);
  });

  it("records a distinguishing reason in the audit trail for each failure, even though the thrown error is identical", async () => {
    const deps = setup();
    const { fullKey } = seedActiveCredential(deps, { status: "REVOKED" });

    await expect(deps.authService.authenticateApiKey(fullKey)).rejects.toBeInstanceOf(AuthenticationError);

    const failureEvents = deps.auditRecorder.events.filter((event) => event.eventType === "AUTHENTICATION_FAILURE");
    expect(failureEvents).toHaveLength(1);
    expect(failureEvents[0]?.metadata).toMatchObject({ reason: "credential_not_active" });
  });

  it("passes requestId/correlationId through into the success audit event", async () => {
    const deps = setup();
    const { fullKey } = seedActiveCredential(deps);

    await deps.authService.authenticateApiKey(fullKey, { requestId: "req-1", correlationId: "corr-1" });

    const successEvent = deps.auditRecorder.events.find((event) => event.eventType === "AUTHENTICATION_SUCCESS");
    expect(successEvent).toMatchObject({ requestId: "req-1", correlationId: "corr-1" });
  });

  it("never includes the raw API key anywhere in a thrown error or recorded audit event", async () => {
    const deps = setup();
    const { fullKey } = seedActiveCredential(deps, { status: "REVOKED" });

    const error = await deps.authService.authenticateApiKey(fullKey).catch((caught: unknown) => caught);

    expect(JSON.stringify(error)).not.toContain(fullKey);
    expect(JSON.stringify(deps.auditRecorder.events)).not.toContain(fullKey);
  });
});
