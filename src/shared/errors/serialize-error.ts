import { AppError } from "./app-error.js";

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly stack?: string;
  readonly cause?: { readonly name: string; readonly message: string };
}

/**
 * Safe, structured representation of a thrown value for logging. Deliberately
 * only pulls `name`/`message`/`stack`/`code`/`cause` off the error — never
 * spreads the error's own enumerable properties, since domain errors carry a
 * `details` bag that may hold data unsafe to serialize wholesale.
 */
export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return {
      name: "NonError",
      message: typeof error === "string" ? error : "An unknown value was thrown",
    };
  }

  const serialized: SerializedError = {
    name: error.name,
    message: error.message,
    ...(error.stack !== undefined ? { stack: error.stack } : {}),
    ...(error instanceof AppError ? { code: error.code } : {}),
    ...(error.cause instanceof Error
      ? { cause: { name: error.cause.name, message: error.cause.message } }
      : {}),
  };

  return serialized;
}
