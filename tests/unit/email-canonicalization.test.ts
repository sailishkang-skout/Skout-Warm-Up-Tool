import { describe, expect, it } from "vitest";
import { canonicalizeEmailAddress } from "../../src/modules/mailbox/domain/email-canonicalization.js";
import { ValidationError } from "../../src/shared/errors/index.js";

describe("canonicalizeEmailAddress", () => {
  it("lowercases both the local part and the domain", () => {
    expect(canonicalizeEmailAddress("User.Name@Example.COM")).toBe("user.name@example.com");
  });

  it("trims surrounding whitespace", () => {
    expect(canonicalizeEmailAddress("  user@example.com  ")).toBe("user@example.com");
  });

  it("is idempotent", () => {
    const once = canonicalizeEmailAddress("Mixed.Case@Example.com");
    expect(canonicalizeEmailAddress(once)).toBe(once);
  });

  it("does NOT strip dots from the local part (Gmail-specific, not general)", () => {
    expect(canonicalizeEmailAddress("u.ser@example.com")).toBe("u.ser@example.com");
    expect(canonicalizeEmailAddress("u.ser@example.com")).not.toBe(
      canonicalizeEmailAddress("user@example.com"),
    );
  });

  it("does NOT strip '+tag' suffixes from the local part (Gmail-specific, not general)", () => {
    expect(canonicalizeEmailAddress("user+newsletter@example.com")).toBe("user+newsletter@example.com");
    expect(canonicalizeEmailAddress("user+newsletter@example.com")).not.toBe(
      canonicalizeEmailAddress("user@example.com"),
    );
  });

  it("rejects a value with no '@'", () => {
    expect(() => canonicalizeEmailAddress("not-an-email")).toThrow(ValidationError);
  });

  it("rejects a value with nothing before the '@'", () => {
    expect(() => canonicalizeEmailAddress("@example.com")).toThrow(ValidationError);
  });

  it("rejects a value with nothing after the '@'", () => {
    expect(() => canonicalizeEmailAddress("user@")).toThrow(ValidationError);
  });

  it("uses the last '@' when splitting local/domain", () => {
    // Rare but RFC-legal: a quoted local part containing '@'. The domain is
    // always what follows the final '@'.
    expect(canonicalizeEmailAddress('"a@b"@example.com')).toBe('"a@b"@example.com');
  });
});
