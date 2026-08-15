import { randomBytes } from "node:crypto";

/**
 * `swu` = Skout Warmup. A recognizable prefix lets a leaked key be
 * identified at a glance (in a git history scan, a log line, a support
 * ticket) as belonging to this service specifically.
 */
export const API_KEY_MARKER = "swu_";

/**
 * The lookup segment is a fixed number of characters so parsing is purely
 * positional — no delimiter is needed between it and the secret, which
 * sidesteps any ambiguity from the secret's own alphabet potentially
 * containing whatever character a delimiter would use.
 */
export const API_KEY_PREFIX_LENGTH = 12;

const PREFIX_ENTROPY_BYTES = 9; // 9 bytes -> 12 base64url chars, no padding
const SECRET_ENTROPY_BYTES = 32; // 256 bits — see api-key-hash.ts for why this matters to the hashing choice

export interface GeneratedApiKey {
  /** The complete string to show the caller. Never persisted or logged anywhere. */
  readonly fullKey: string;
  /** Safe to store/index in plaintext — carries no secret material on its own. */
  readonly prefix: string;
  /** Never persisted directly — only `hashApiKeySecret(secret, pepper)` is stored. */
  readonly secret: string;
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(PREFIX_ENTROPY_BYTES).toString("base64url");
  const secret = randomBytes(SECRET_ENTROPY_BYTES).toString("base64url");
  return { fullKey: `${API_KEY_MARKER}${prefix}${secret}`, prefix, secret };
}

export interface ParsedApiKey {
  readonly prefix: string;
  readonly secret: string;
}

/**
 * Purely structural parsing — does not touch the database or verify
 * anything cryptographic. Returns `undefined` for any string that doesn't
 * even have the right shape, so callers can short-circuit before a DB
 * round-trip for obviously-malformed input.
 */
export function parseApiKey(rawKey: string): ParsedApiKey | undefined {
  if (!rawKey.startsWith(API_KEY_MARKER)) {
    return undefined;
  }
  const rest = rawKey.slice(API_KEY_MARKER.length);
  if (rest.length <= API_KEY_PREFIX_LENGTH) {
    return undefined;
  }
  return {
    prefix: rest.slice(0, API_KEY_PREFIX_LENGTH),
    secret: rest.slice(API_KEY_PREFIX_LENGTH),
  };
}
