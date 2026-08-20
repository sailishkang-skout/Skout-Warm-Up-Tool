import type { ManagedDirectoryErrorCode, ManagedDirectoryResult } from "../domain/managed-directory-provider.js";

export function directoryFailure<T>(
  errorCode: ManagedDirectoryErrorCode | undefined,
  safeReason: string | undefined,
): ManagedDirectoryResult<T> {
  return {
    ok: false,
    errorCode: errorCode ?? "UNKNOWN",
    ...(safeReason ? { safeReason } : {}),
  };
}

export interface DirectoryHttpResponse {
  readonly status: number;
  readonly json: unknown;
}

export function mapDirectoryHttpStatus(status: number): ManagedDirectoryErrorCode {
  if (status === 401) {
    return "AUTH_ERROR";
  }
  if (status === 403) {
    return "PERMISSION_DENIED";
  }
  if (status === 404) {
    return "NOT_FOUND";
  }
  if (status === 409) {
    return "ALREADY_EXISTS";
  }
  if (status === 400 || status === 422) {
    return "VALIDATION_ERROR";
  }
  if (status === 429) {
    return "RATE_LIMIT";
  }
  if (status >= 500) {
    return "NETWORK_ERROR";
  }
  return "UNKNOWN";
}

export function mapDirectoryTransportError(error: unknown): ManagedDirectoryErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|AbortError/i.test(message)) {
    return "NETWORK_ERROR";
  }
  if (/ECONNRESET|ENOTFOUND|fetch failed|network/i.test(message)) {
    return "NETWORK_ERROR";
  }
  return "UNKNOWN";
}

export function readProviderId(json: unknown, keys: readonly string[]): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const record = json as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}
