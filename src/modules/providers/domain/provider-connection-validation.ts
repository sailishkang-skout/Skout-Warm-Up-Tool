/**
 * The outcome of attempting to validate a mailbox's connection to its
 * provider. `NOT_CONFIGURED` is a first-class, expected outcome — not an
 * exceptional one — for exactly the situation every Stage 5 adapter is in:
 * no OAuth/SMTP implementation exists yet, so validation cannot proceed.
 * Distinguishing it from `INVALID_CREDENTIAL`/`PROVIDER_ERROR` lets callers
 * (and the mailbox lifecycle) tell "nothing to try yet" apart from
 * "we tried and the provider said no".
 */
export const PROVIDER_CONNECTION_VALIDATION_STATUSES = [
  "VALID",
  "NOT_CONFIGURED",
  "INVALID_CREDENTIAL",
  "PROVIDER_ERROR",
] as const;
export type ProviderConnectionValidationStatus = (typeof PROVIDER_CONNECTION_VALIDATION_STATUSES)[number];

export interface ProviderConnectionValidationResult {
  readonly status: ProviderConnectionValidationStatus;
  /** Safe, curated — never a raw provider/OAuth error message. */
  readonly message: string;
  readonly checkedAt: Date;
}
