import { DatabaseError as PgDatabaseError } from "pg";
import { describe, expect, it } from "vitest";
import { mapDatabaseError } from "../../src/shared/db/index.js";
import { AppError, ConflictError, DatabaseError, TransientError, ValidationError } from "../../src/shared/errors/index.js";

function createPgError(code: string, overrides: Partial<PgDatabaseError> = {}): PgDatabaseError {
  const error = new PgDatabaseError("a postgres error occurred", 0, "error");
  error.code = code;
  Object.assign(error, overrides);
  return error;
}

describe("mapDatabaseError", () => {
  it("passes an existing AppError through unchanged", () => {
    const original = new ValidationError("already an AppError");
    expect(mapDatabaseError(original)).toBe(original);
  });

  it("maps a unique_violation (23505) to ConflictError", () => {
    const mapped = mapDatabaseError(createPgError("23505", { constraint: "mailboxes_tenant_email_canonical_unique" }));
    expect(mapped).toBeInstanceOf(ConflictError);
    expect(mapped.code).toBe("CONFLICT");
  });

  it("maps a foreign_key_violation (23503) to ConflictError", () => {
    const mapped = mapDatabaseError(createPgError("23503", { constraint: "mailboxes_tenant_id_fkey" }));
    expect(mapped).toBeInstanceOf(ConflictError);
  });

  it("maps a not_null_violation (23502) to ValidationError", () => {
    const mapped = mapDatabaseError(createPgError("23502", { column: "email_address" }));
    expect(mapped).toBeInstanceOf(ValidationError);
  });

  it("maps a check_violation (23514) to ValidationError", () => {
    const mapped = mapDatabaseError(createPgError("23514", { constraint: "mailboxes_status_check" }));
    expect(mapped).toBeInstanceOf(ValidationError);
  });

  it("maps an unrecognized pg error code to DatabaseError", () => {
    const mapped = mapDatabaseError(createPgError("55006"));
    expect(mapped).toBeInstanceOf(DatabaseError);
    expect(mapped).not.toBeInstanceOf(ConflictError);
    expect(mapped).not.toBeInstanceOf(ValidationError);
  });

  it("maps a connection-refused Node error to TransientError", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" });
    const mapped = mapDatabaseError(error);
    expect(mapped).toBeInstanceOf(TransientError);
  });

  it("maps a plain Error with no recognizable code to DatabaseError", () => {
    const mapped = mapDatabaseError(new Error("something unexpected"));
    expect(mapped).toBeInstanceOf(DatabaseError);
  });

  it("maps a non-Error thrown value to DatabaseError", () => {
    expect(mapDatabaseError("just a string")).toBeInstanceOf(DatabaseError);
  });

  it("never includes the pg error's `.detail` field, which may contain offending row values", () => {
    const error = createPgError("23505", {
      detail: "Key (email_address_canonical)=(user@example.com) already exists.",
    });
    const mapped = mapDatabaseError(error);
    expect(JSON.stringify(mapped.details)).not.toContain("user@example.com");
  });

  it("keeps `.constraint`/`.table`/`.column` in details — safe, structural, not data", () => {
    const error = createPgError("23505", {
      constraint: "mailboxes_tenant_email_canonical_unique",
      table: "mailboxes",
      column: undefined,
    });
    const mapped = mapDatabaseError(error);
    expect(mapped.details).toMatchObject({
      constraint: "mailboxes_tenant_email_canonical_unique",
      table: "mailboxes",
    });
  });

  it("every mapped error is a real AppError with a safe public message", () => {
    const mapped = mapDatabaseError(createPgError("23505"));
    expect(mapped).toBeInstanceOf(AppError);
    expect(mapped.toPublicJSON().error.message).not.toContain("postgres");
  });
});
