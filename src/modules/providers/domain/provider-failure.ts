/**
 * Normalized provider HTTP/network failures for inbound and operational
 * logging. Send-path adapters keep their existing SendResult statuses —
 * this taxonomy does not change warmup sendMessage semantics.
 */
export const PROVIDER_FAILURE_CATEGORIES = [
  "AUTHENTICATION_ERROR",
  "AUTHORIZATION_ERROR",
  "RATE_LIMITED",
  "TEMPORARY_PROVIDER_ERROR",
  "PERMANENT_PROVIDER_ERROR",
  "INVALID_REQUEST",
  "TIMEOUT",
  "NETWORK_ERROR",
  "CURSOR_INVALID",
  "MESSAGE_NOT_FOUND",
  "UNKNOWN_PROVIDER_ERROR",
] as const;

export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

export interface ClassifiedProviderFailure {
  readonly category: ProviderFailureCategory;
  readonly retryable: boolean;
  readonly httpStatus?: number;
}

export function classifyProviderHttpStatus(status: number): ClassifiedProviderFailure {
  if (status === 401) {
    return { category: "AUTHENTICATION_ERROR", retryable: false, httpStatus: status };
  }
  if (status === 403) {
    return { category: "AUTHORIZATION_ERROR", retryable: false, httpStatus: status };
  }
  if (status === 404) {
    return { category: "MESSAGE_NOT_FOUND", retryable: false, httpStatus: status };
  }
  if (status === 400 || status === 410 || status === 422) {
    return { category: "INVALID_REQUEST", retryable: false, httpStatus: status };
  }
  if (status === 429) {
    return { category: "RATE_LIMITED", retryable: true, httpStatus: status };
  }
  if (status >= 500 && status <= 599) {
    return { category: "TEMPORARY_PROVIDER_ERROR", retryable: true, httpStatus: status };
  }
  return { category: "UNKNOWN_PROVIDER_ERROR", retryable: false, httpStatus: status };
}

export function classifyProviderTransportError(error: unknown): ClassifiedProviderFailure {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(message)) {
    return { category: "TIMEOUT", retryable: true };
  }
  if (/fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(message)) {
    return { category: "NETWORK_ERROR", retryable: true };
  }
  return { category: "UNKNOWN_PROVIDER_ERROR", retryable: false };
}

export function retryAfterDelayMs(header: string | null, random: () => number = Math.random): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number.parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  const baseMs = seconds * 1000;
  const jitter = Math.round(baseMs * 0.1 * random());
  return baseMs + jitter;
}
