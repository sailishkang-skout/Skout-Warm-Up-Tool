import { describe, expect, it } from "vitest";
import { createInMemoryProviderCredentialStore } from "../../src/modules/providers/infrastructure/in-memory-provider-credential-store.js";
import { ConfigurationError } from "../../src/shared/errors/index.js";
import { asProviderAccountId } from "../../src/shared/types/index.js";
import type { ProviderCredential } from "../../src/modules/providers/domain/provider-credential.js";

const ACCOUNT_ID = asProviderAccountId("11111111-1111-1111-1111-111111111111");
const OTHER_ACCOUNT_ID = asProviderAccountId("22222222-2222-2222-2222-222222222222");

const CREDENTIAL: ProviderCredential = {
  providerAccountId: ACCOUNT_ID,
  kind: "GOOGLE_OAUTH",
  secretData: { accessToken: "fake-for-test-only" },
};

describe("createInMemoryProviderCredentialStore", () => {
  it("refuses to construct when isProduction is true", () => {
    expect(() => createInMemoryProviderCredentialStore({ isProduction: true })).toThrow(ConfigurationError);
  });

  it("constructs fine when isProduction is false", () => {
    expect(() => createInMemoryProviderCredentialStore({ isProduction: false })).not.toThrow();
  });

  it("returns undefined for a credential that was never saved", async () => {
    const store = createInMemoryProviderCredentialStore({ isProduction: false });
    expect(await store.getCredential(ACCOUNT_ID)).toBeUndefined();
  });

  it("round-trips a saved credential", async () => {
    const store = createInMemoryProviderCredentialStore({ isProduction: false });
    await store.saveCredential(CREDENTIAL);
    expect(await store.getCredential(ACCOUNT_ID)).toEqual(CREDENTIAL);
  });

  it("keeps credentials for different provider accounts independent", async () => {
    const store = createInMemoryProviderCredentialStore({ isProduction: false });
    await store.saveCredential(CREDENTIAL);
    expect(await store.getCredential(OTHER_ACCOUNT_ID)).toBeUndefined();
  });

  it("revokeCredential removes it", async () => {
    const store = createInMemoryProviderCredentialStore({ isProduction: false });
    await store.saveCredential(CREDENTIAL);
    await store.revokeCredential(ACCOUNT_ID);
    expect(await store.getCredential(ACCOUNT_ID)).toBeUndefined();
  });

  it("revokeCredential on a nonexistent entry does not throw", async () => {
    const store = createInMemoryProviderCredentialStore({ isProduction: false });
    await expect(store.revokeCredential(ACCOUNT_ID)).resolves.toBeUndefined();
  });

  it("saveCredential overwrites an existing credential for the same account", async () => {
    const store = createInMemoryProviderCredentialStore({ isProduction: false });
    await store.saveCredential(CREDENTIAL);
    const replacement: ProviderCredential = { ...CREDENTIAL, secretData: { accessToken: "replaced" } };
    await store.saveCredential(replacement);
    expect(await store.getCredential(ACCOUNT_ID)).toEqual(replacement);
  });
});
