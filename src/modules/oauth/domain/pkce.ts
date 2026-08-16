import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/**
 * RFC 7636 PKCE (S256 only — the "plain" method exists for clients that
 * cannot compute SHA-256, which does not apply to a server-side adapter).
 * 32 random bytes base64url-encode to 43 characters, the minimum valid
 * `code_verifier` length and comfortably within the 43-128 range the spec
 * requires.
 */
export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
