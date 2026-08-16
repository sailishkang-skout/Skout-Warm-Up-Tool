import { describe, expect, it } from "vitest";
import { createInMemoryOAuthStateStore } from "../../src/modules/oauth/infrastructure/in-memory-oauth-state-store.js";
import { asMailboxId, asTenantId } from "../../src/shared/types/index.js";
import type { OAuthStateRecord } from "../../src/modules/oauth/domain/oauth-state.js";

const RECORD: OAuthStateRecord = {
  tenantId: asTenantId("11111111-1111-1111-1111-111111111111"),
  mailboxId: asMailboxId("22222222-2222-2222-2222-222222222222"),
  provider: "GMAIL",
  codeVerifier: "verifier-value",
};

describe("createInMemoryOAuthStateStore", () => {
  it("consume returns the exact record that was created", async () => {
    const store = createInMemoryOAuthStateStore();
    const { state } = await store.create(RECORD);
    await expect(store.consume(state)).resolves.toEqual(RECORD);
  });

  it("returns undefined for a state that was never created", async () => {
    const store = createInMemoryOAuthStateStore();
    await expect(store.consume("never-created")).resolves.toBeUndefined();
  });

  it("is single-use — a second consume of the same state returns undefined (replay protection)", async () => {
    const store = createInMemoryOAuthStateStore();
    const { state } = await store.create(RECORD);
    await store.consume(state);
    await expect(store.consume(state)).resolves.toBeUndefined();
  });

  it("expires after its TTL", async () => {
    const store = createInMemoryOAuthStateStore(10); // 10ms TTL
    const { state } = await store.create(RECORD);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(store.consume(state)).resolves.toBeUndefined();
  });

  it("generates unguessable, unique state tokens", async () => {
    const store = createInMemoryOAuthStateStore();
    const first = await store.create(RECORD);
    const second = await store.create(RECORD);
    expect(first.state).not.toBe(second.state);
    expect(first.state.length).toBeGreaterThanOrEqual(32);
  });
});
