import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HASHING STRATEGY — HMAC-SHA256 with a server-side pepper, not a password
 * KDF (bcrypt/argon2/scrypt).
 *
 * Password KDFs exist to slow down brute-forcing a *low-entropy* secret —
 * human passwords typically carry on the order of 20-40 bits of effective
 * entropy, so an attacker with a stolen hash can feasibly try billions of
 * candidates; deliberately expensive hashing (bcrypt costs ~50-200ms by
 * design) is what makes that infeasible.
 *
 * The secret half of this service's API keys is 256 bits of CSPRNG output
 * (see api-key.ts — `randomBytes(32)`). Brute-forcing that is
 * computationally infeasible regardless of hash speed: a fast hash still
 * requires ~2^256 attempts. Spending 50-200ms of CPU per verification would
 * buy no meaningful security here, while directly costing latency and
 * throughput on *every authenticated request* this service receives — a
 * self-inflicted DoS surface for no benefit. The real defense for
 * high-entropy secrets is generation (a real CSPRNG, sufficient length),
 * not verification cost.
 *
 * The pepper (`API_KEY_PEPPER`, server-side config, never persisted in the
 * database) is what HMAC buys over a plain `sha256(secret)`: if the
 * `api_credentials` table is ever exfiltrated without the application's
 * environment config also leaking, the stolen hashes are useless offline —
 * verifying a guess requires the pepper too. It costs nothing extra (still
 * one fast HMAC op) and raises the bar for a partial breach.
 */
export function hashApiKeySecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret, "utf8").digest("hex");
}

/**
 * Constant-time comparison — a naive `===` on the hex digests would leak,
 * via timing, how many leading bytes of a guess happened to match, letting
 * an attacker reconstruct a valid hash byte-by-byte over many requests.
 */
export function verifyApiKeySecret(secret: string, pepper: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKeySecret(secret, pepper), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/**
 * A hash of a fixed, non-secret placeholder — HMAC of the empty string
 * under this process's real pepper. Used to give the "credential not found"
 * path a verification to perform, so its timing looks like the "credential
 * found, secret wrong" path instead of returning early and creating a
 * timing side-channel an attacker could use to enumerate valid key
 * prefixes. See authentication-service.ts.
 */
export function dummyHashFor(pepper: string): string {
  return hashApiKeySecret("", pepper);
}
