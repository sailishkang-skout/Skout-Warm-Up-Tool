const SENSITIVE_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|encryption[_-]?key|authorization|auth[_-]?header|credential|private[_-]?key)/i;

const REDACTED_PLACEHOLDER = "[REDACTED]";
const MAX_DEPTH = 8;

/**
 * Recursively redacts any object key matching a known-sensitive pattern,
 * regardless of nesting depth or exact path — a complement to pino's
 * path-based `redact` option, which only catches shapes it was told about in
 * advance. Used explicitly at call sites logging arbitrary structured data
 * (e.g. an error's internal `details` bag).
 */
export function sanitizeForLogging<T>(value: T, depth = 0): T {
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object" || value instanceof Error) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLogging(item, depth + 1)) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED_PLACEHOLDER
      : sanitizeForLogging(entry, depth + 1);
  }
  return result as T;
}
