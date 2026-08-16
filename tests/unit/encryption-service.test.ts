import { describe, expect, it } from "vitest";
import { createEncryptionService } from "../../src/shared/crypto/index.js";
import { ConfigurationError, CredentialError } from "../../src/shared/errors/index.js";

const KEY_A = "a".repeat(32);
const KEY_B = "b".repeat(32);

describe("createEncryptionService", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const service = createEncryptionService([{ version: 1, rawKey: KEY_A }], 1);
    const payload = service.encrypt("super-secret-token");
    expect(service.decrypt(payload)).toBe("super-secret-token");
  });

  it("never stores the plaintext anywhere in the encrypted payload", () => {
    const service = createEncryptionService([{ version: 1, rawKey: KEY_A }], 1);
    const payload = service.encrypt("super-secret-token");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("super-secret-token");
  });

  it("encrypts the same plaintext differently every time (random IV)", () => {
    const service = createEncryptionService([{ version: 1, rawKey: KEY_A }], 1);
    const first = service.encrypt("same-plaintext");
    const second = service.encrypt("same-plaintext");
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.iv).not.toBe(second.iv);
    // But both still decrypt to the same plaintext.
    expect(service.decrypt(first)).toBe("same-plaintext");
    expect(service.decrypt(second)).toBe("same-plaintext");
  });

  it("rejects a tampered ciphertext (authentication failure)", () => {
    const service = createEncryptionService([{ version: 1, rawKey: KEY_A }], 1);
    const payload = service.encrypt("super-secret-token");
    const tampered = { ...payload, ciphertext: Buffer.from("tampered-bytes-here").toString("base64") };
    expect(() => service.decrypt(tampered)).toThrow(CredentialError);
  });

  it("rejects a tampered auth tag", () => {
    const service = createEncryptionService([{ version: 1, rawKey: KEY_A }], 1);
    const payload = service.encrypt("super-secret-token");
    const tampered = { ...payload, authTag: Buffer.alloc(16, 1).toString("base64") };
    expect(() => service.decrypt(tampered)).toThrow(CredentialError);
  });

  it("cannot decrypt with the wrong key", () => {
    const serviceA = createEncryptionService([{ version: 1, rawKey: KEY_A }], 1);
    const serviceB = createEncryptionService([{ version: 1, rawKey: KEY_B }], 1);
    const payload = serviceA.encrypt("super-secret-token");
    expect(() => serviceB.decrypt(payload)).toThrow(CredentialError);
  });

  it("supports decrypting an old version after the current key rotates", () => {
    const oldService = createEncryptionService([{ version: 1, rawKey: KEY_A }], 1);
    const oldPayload = oldService.encrypt("legacy-token");

    // Simulates rotation: both keys registered, currentVersion bumped to 2.
    const rotatedService = createEncryptionService(
      [
        { version: 1, rawKey: KEY_A },
        { version: 2, rawKey: KEY_B },
      ],
      2,
    );

    expect(rotatedService.decrypt(oldPayload)).toBe("legacy-token");
    const newPayload = rotatedService.encrypt("new-token");
    expect(newPayload.version).toBe(2);
    expect(rotatedService.decrypt(newPayload)).toBe("new-token");
  });

  it("throws CredentialError for a payload whose version has no registered key", () => {
    const service = createEncryptionService([{ version: 2, rawKey: KEY_A }], 2);
    expect(() => service.decrypt({ version: 99, iv: "AA==", authTag: "AA==", ciphertext: "AA==" })).toThrow(
      CredentialError,
    );
  });

  it("throws ConfigurationError when constructed with no keys", () => {
    expect(() => createEncryptionService([], 1)).toThrow(ConfigurationError);
  });

  it("throws ConfigurationError when currentVersion has no matching key", () => {
    expect(() => createEncryptionService([{ version: 1, rawKey: KEY_A }], 2)).toThrow(ConfigurationError);
  });

  it("throws ConfigurationError on duplicate key versions", () => {
    expect(() =>
      createEncryptionService(
        [
          { version: 1, rawKey: KEY_A },
          { version: 1, rawKey: KEY_B },
        ],
        1,
      ),
    ).toThrow(ConfigurationError);
  });
});
