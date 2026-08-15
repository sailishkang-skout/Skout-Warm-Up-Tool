import { describe, expect, it } from "vitest";
import { dummyHashFor, hashApiKeySecret, verifyApiKeySecret } from "../../src/modules/auth/domain/api-key-hash.js";

const PEPPER_A = "a".repeat(32);
const PEPPER_B = "b".repeat(32);

describe("hashApiKeySecret", () => {
  it("is deterministic for the same secret and pepper", () => {
    expect(hashApiKeySecret("my-secret", PEPPER_A)).toBe(hashApiKeySecret("my-secret", PEPPER_A));
  });

  it("produces a 64-character hex digest (SHA-256)", () => {
    expect(hashApiKeySecret("my-secret", PEPPER_A)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces a different hash for a different secret", () => {
    expect(hashApiKeySecret("secret-one", PEPPER_A)).not.toBe(hashApiKeySecret("secret-two", PEPPER_A));
  });

  it("produces a different hash for a different pepper, same secret", () => {
    expect(hashApiKeySecret("my-secret", PEPPER_A)).not.toBe(hashApiKeySecret("my-secret", PEPPER_B));
  });

  it("never includes the secret or pepper verbatim in its output", () => {
    const hash = hashApiKeySecret("my-secret", PEPPER_A);
    expect(hash).not.toContain("my-secret");
    expect(hash).not.toContain(PEPPER_A);
  });
});

describe("verifyApiKeySecret", () => {
  it("returns true for the correct secret/pepper pair", () => {
    const hash = hashApiKeySecret("correct-secret", PEPPER_A);
    expect(verifyApiKeySecret("correct-secret", PEPPER_A, hash)).toBe(true);
  });

  it("returns false for the wrong secret", () => {
    const hash = hashApiKeySecret("correct-secret", PEPPER_A);
    expect(verifyApiKeySecret("wrong-secret", PEPPER_A, hash)).toBe(false);
  });

  it("returns false for the wrong pepper", () => {
    const hash = hashApiKeySecret("correct-secret", PEPPER_A);
    expect(verifyApiKeySecret("correct-secret", PEPPER_B, hash)).toBe(false);
  });

  it("returns false rather than throwing when the stored hash has a different length", () => {
    expect(verifyApiKeySecret("correct-secret", PEPPER_A, "not-a-real-hash")).toBe(false);
  });

  it("returns false for an empty candidate secret against a real hash", () => {
    const hash = hashApiKeySecret("correct-secret", PEPPER_A);
    expect(verifyApiKeySecret("", PEPPER_A, hash)).toBe(false);
  });
});

describe("dummyHashFor", () => {
  it("produces a well-formed 64-character hex digest", () => {
    expect(dummyHashFor(PEPPER_A)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for a given pepper", () => {
    expect(dummyHashFor(PEPPER_A)).toBe(dummyHashFor(PEPPER_A));
  });

  it("never verifies successfully against any real secret", () => {
    const dummy = dummyHashFor(PEPPER_A);
    expect(verifyApiKeySecret("", PEPPER_A, dummy)).toBe(true); // it's the hash of "" — verifying "" is the one exception
    expect(verifyApiKeySecret("any-real-secret", PEPPER_A, dummy)).toBe(false);
  });
});
