import type { ProviderCredentialStatus } from "./provider-credential-status.js";

/**
 * Derived operational view of a stored credential. Persistence remains
 * ACTIVE / EXPIRED / REVOKED (migration 007). This mapping is read-time so
 * we do not rewrite frozen credential rows.
 */
export const CREDENTIAL_LIFECYCLE_STATES = [
  "PENDING",
  "ACTIVE",
  "EXPIRING",
  "REFRESH_REQUIRED",
  "REVOKED",
  "FAILED",
] as const;
export type CredentialLifecycleState = (typeof CREDENTIAL_LIFECYCLE_STATES)[number];

const EXPIRING_WINDOW_MS = 24 * 60 * 60 * 1000;

export function classifyCredentialLifecycle(input: {
  readonly storedStatus?: ProviderCredentialStatus;
  readonly expiresAt?: Date;
  readonly now?: Date;
}): CredentialLifecycleState {
  if (!input.storedStatus) {
    return "PENDING";
  }
  if (input.storedStatus === "REVOKED") {
    return "REVOKED";
  }
  if (input.storedStatus === "EXPIRED") {
    return "REFRESH_REQUIRED";
  }
  const now = input.now ?? new Date();
  if (input.expiresAt && input.expiresAt.getTime() <= now.getTime()) {
    return "REFRESH_REQUIRED";
  }
  if (input.expiresAt && input.expiresAt.getTime() - now.getTime() <= EXPIRING_WINDOW_MS) {
    return "EXPIRING";
  }
  return "ACTIVE";
}
