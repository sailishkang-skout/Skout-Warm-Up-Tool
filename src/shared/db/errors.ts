import { DatabaseError as PgDatabaseError } from "pg";
import { AppError, ConflictError, DatabaseError, TransientError, ValidationError } from "../errors/index.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
const NOT_NULL_VIOLATION = "23502";
const CHECK_VIOLATION = "23514";

const TRANSIENT_CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
]);

/**
 * Maps a raw thrown value from `pg` into the Stage 2 `AppError` hierarchy.
 * Deliberately never puts `error.detail`/`.hint`/`.internalQuery` into
 * `details` — Postgres embeds the actual offending values there (e.g.
 * `Key (email)=(user@example.com) already exists.`), which is exactly the
 * "sensitive parameter value" this service must never log. `.message`,
 * `.constraint`, `.table`, `.column` are safe: Postgres keeps those
 * structural (identifier names, not data).
 */
export function mapDatabaseError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof PgDatabaseError) {
    const details = {
      pgCode: error.code,
      constraint: error.constraint,
      table: error.table,
      column: error.column,
    };

    switch (error.code) {
      case UNIQUE_VIOLATION:
        return new ConflictError("A record with this value already exists", { details, cause: error });
      case FOREIGN_KEY_VIOLATION:
        return new ConflictError(
          "This operation references a record that does not exist, or the record is still in use",
          { details, cause: error },
        );
      case NOT_NULL_VIOLATION:
      case CHECK_VIOLATION:
        return new ValidationError("The provided data violates a database constraint", {
          details,
          cause: error,
        });
      default:
        return new DatabaseError("A database error occurred", { details, cause: error });
    }
  }

  if (error instanceof Error && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CONNECTION_ERROR_CODES.has(code)) {
      return new TransientError("The database is temporarily unavailable", {
        details: { code },
        cause: error,
      });
    }
  }

  return new DatabaseError("A database error occurred", { cause: error });
}
