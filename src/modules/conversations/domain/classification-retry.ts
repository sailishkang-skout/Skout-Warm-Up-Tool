export const CLASSIFICATION_MAX_ATTEMPTS = 5;
/** Malformed model JSON is retried once, then classified as UNKNOWN — never as a pos/neg fact. */
export const CLASSIFICATION_MALFORMED_MAX_ATTEMPTS = 2;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60_000;

export interface ClassificationRetryDecision {
  readonly shouldRetry: boolean;
  readonly delayMs?: number;
  readonly reason: string;
}

export function decideClassificationRetry(
  retryable: boolean,
  attemptCount: number,
  random: () => number = Math.random,
): ClassificationRetryDecision {
  if (!retryable) {
    return { shouldRetry: false, reason: "failure is not retryable" };
  }
  if (attemptCount >= CLASSIFICATION_MAX_ATTEMPTS) {
    return { shouldRetry: false, reason: `maximum attempts (${CLASSIFICATION_MAX_ATTEMPTS}) reached` };
  }
  const exponential = BASE_DELAY_MS * 2 ** attemptCount;
  const cap = Math.min(exponential, MAX_DELAY_MS);
  const delayMs = Math.round(cap / 2 + (cap / 2) * random());
  return { shouldRetry: true, delayMs, reason: "retryable classification failure, attempts remain" };
}

export function decideMalformedClassificationRetry(
  attemptCount: number,
  random: () => number = Math.random,
): ClassificationRetryDecision {
  if (attemptCount >= CLASSIFICATION_MALFORMED_MAX_ATTEMPTS) {
    return { shouldRetry: false, reason: "malformed classifier output exhausted retry; persist UNKNOWN" };
  }
  return decideClassificationRetry(true, attemptCount, random);
}
