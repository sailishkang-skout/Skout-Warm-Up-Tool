import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ConfigurationError, CredentialError } from "../errors/index.js";

const ALGORITHM = "aes-256-gcm";
// 96-bit nonce — the size GCM is designed for. A longer IV would be hashed
// down internally by the construction, which weakens its guarantees; this is
// not an arbitrary choice.
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const SELF_TEST_PLAINTEXT = "skout-encryption-self-test";

export interface EncryptedPayload {
  readonly version: number;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

export interface EncryptionKeyDefinition {
  readonly version: number;
  readonly rawKey: string;
}

export interface EncryptionService {
  readonly currentVersion: number;
  encrypt(plaintext: string): EncryptedPayload;
  decrypt(payload: EncryptedPayload): string;
}

/**
 * ENCRYPTION_KEY is already a high-entropy application secret (config
 * requires >=32 chars, generated and managed like any other deployment
 * secret) — not a user-chosen password. Deriving the raw AES key with
 * SHA-256 rather than a deliberately-slow password KDF (scrypt/argon2) is
 * the same reasoning Stage 4 applied to API key hashing (see
 * src/modules/auth/domain/api-key-hash.ts): slow KDFs defend against
 * brute-forcing a low-entropy secret, which this isn't.
 */
function deriveKey(rawKey: string): Buffer {
  return createHash("sha256").update(rawKey, "utf8").digest();
}

function encryptWith(version: number, key: Buffer, plaintext: string): EncryptedPayload {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    version,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptWith(key: Buffer, payload: EncryptedPayload): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, "base64"), {
      authTagLength: AUTH_TAG_LENGTH_BYTES,
    });
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, "base64")), decipher.final()]);
    return plaintext.toString("utf8");
  } catch (error) {
    // Wrong key, tampered ciphertext, and a corrupted iv/authTag all fail the
    // same way here (GCM's `final()` throws on auth-tag mismatch) — that's
    // deliberate, not a gap: distinguishing them in the error would tell an
    // attacker which part of a forged payload was wrong.
    throw new CredentialError("Failed to decrypt stored credential", { cause: error });
  }
}

/**
 * `keys` supports more than one version so a credential encrypted under a
 * since-rotated key can still be decrypted: rotation is "add a new key at a
 * higher version, point `currentVersion` at it, leave old keys registered
 * until every row has been re-encrypted under the new one" — never
 * "overwrite the old key," which would strand every credential still
 * encrypted under it. Only one key is registered today (from
 * config.security.encryptionKey); a future rotation lands as an additional
 * env-sourced entry in this list plus a bump to `currentVersion`, with no
 * change to callers or the credential store.
 */
export function createEncryptionService(
  keys: readonly EncryptionKeyDefinition[],
  currentVersion: number,
): EncryptionService {
  if (keys.length === 0) {
    throw new ConfigurationError("createEncryptionService requires at least one encryption key");
  }

  const derivedKeys = new Map<number, Buffer>();
  for (const { version, rawKey } of keys) {
    if (derivedKeys.has(version)) {
      throw new ConfigurationError(`Duplicate encryption key version ${version}`);
    }
    derivedKeys.set(version, deriveKey(rawKey));
  }

  const currentKey = derivedKeys.get(currentVersion);
  if (!currentKey) {
    throw new ConfigurationError(`No encryption key registered for currentVersion ${currentVersion}`);
  }

  // Key validation at startup: prove this exact key round-trips through the
  // real encrypt/decrypt path before anything depends on it — a malformed
  // key should fail the deployment at boot, not the first time a mailbox
  // connection tries to store a credential.
  try {
    const probe = encryptWith(currentVersion, currentKey, SELF_TEST_PLAINTEXT);
    const roundTripped = decryptWith(currentKey, probe);
    if (roundTripped !== SELF_TEST_PLAINTEXT) {
      throw new Error("round-trip mismatch");
    }
  } catch (error) {
    throw new ConfigurationError("ENCRYPTION_KEY failed self-test at startup", { cause: error });
  }

  return {
    currentVersion,
    encrypt(plaintext: string): EncryptedPayload {
      return encryptWith(currentVersion, currentKey, plaintext);
    },
    decrypt(payload: EncryptedPayload): string {
      const key = derivedKeys.get(payload.version);
      if (!key) {
        throw new CredentialError(
          `No encryption key registered for version ${payload.version} — cannot decrypt this credential`,
        );
      }
      return decryptWith(key, payload);
    },
  };
}
