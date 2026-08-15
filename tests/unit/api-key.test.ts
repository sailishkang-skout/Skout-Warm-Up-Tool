import { describe, expect, it } from "vitest";
import {
  API_KEY_MARKER,
  API_KEY_PREFIX_LENGTH,
  generateApiKey,
  parseApiKey,
} from "../../src/modules/auth/domain/api-key.js";

describe("generateApiKey", () => {
  it("produces a key starting with the Skout marker", () => {
    expect(generateApiKey().fullKey.startsWith(API_KEY_MARKER)).toBe(true);
  });

  it("produces a prefix of the declared fixed length", () => {
    expect(generateApiKey().prefix).toHaveLength(API_KEY_PREFIX_LENGTH);
  });

  it("produces a high-entropy secret (256 bits, base64url -> 43 chars)", () => {
    expect(generateApiKey().secret).toHaveLength(43);
  });

  it("concatenates marker + prefix + secret exactly as the full key", () => {
    const key = generateApiKey();
    expect(key.fullKey).toBe(`${API_KEY_MARKER}${key.prefix}${key.secret}`);
  });

  it("never generates the same key, prefix, or secret twice across many calls", () => {
    const seenKeys = new Set<string>();
    const seenPrefixes = new Set<string>();
    const seenSecrets = new Set<string>();

    for (let i = 0; i < 1000; i += 1) {
      const key = generateApiKey();
      expect(seenKeys.has(key.fullKey)).toBe(false);
      expect(seenPrefixes.has(key.prefix)).toBe(false);
      expect(seenSecrets.has(key.secret)).toBe(false);
      seenKeys.add(key.fullKey);
      seenPrefixes.add(key.prefix);
      seenSecrets.add(key.secret);
    }
  });

  it("uses a URL-safe alphabet only (no characters requiring escaping in headers/URLs)", () => {
    const key = generateApiKey();
    expect(key.fullKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("parseApiKey", () => {
  it("round-trips a freshly generated key into the same prefix/secret", () => {
    const generated = generateApiKey();
    const parsed = parseApiKey(generated.fullKey);
    expect(parsed).toEqual({ prefix: generated.prefix, secret: generated.secret });
  });

  it("rejects a key missing the marker", () => {
    expect(parseApiKey("not_the_right_prefix_abcdefghijklmnopqrstuvwxyz")).toBeUndefined();
  });

  it("rejects a key with no secret after the prefix", () => {
    expect(parseApiKey(`${API_KEY_MARKER}${"a".repeat(API_KEY_PREFIX_LENGTH)}`)).toBeUndefined();
  });

  it("rejects an empty string", () => {
    expect(parseApiKey("")).toBeUndefined();
  });

  it("rejects a key shorter than the marker plus prefix length", () => {
    expect(parseApiKey(`${API_KEY_MARKER}short`)).toBeUndefined();
  });

  it("extracts the correct prefix/secret split by position, not by any delimiter character", () => {
    const secretWithUnderscoresAndDashes = "abc_def-ghi_jkl-mno_pqr-stu_vwx-yz0_123-456";
    const fullKey = `${API_KEY_MARKER}${"p".repeat(API_KEY_PREFIX_LENGTH)}${secretWithUnderscoresAndDashes}`;
    expect(parseApiKey(fullKey)).toEqual({
      prefix: "p".repeat(API_KEY_PREFIX_LENGTH),
      secret: secretWithUnderscoresAndDashes,
    });
  });
});
