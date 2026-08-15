import { DatabaseError } from "../errors/index.js";

/**
 * For `INSERT ... RETURNING` (or similarly single-row-guaranteed) queries,
 * where the row's existence is a SQL-level invariant, not something the
 * caller needs to branch on. Throwing here — rather than a non-null
 * assertion at every call site — keeps that invariant enforced in one place
 * and gives a real error instead of `undefined` propagating silently if it's
 * ever violated.
 */
export function expectOne<T>(rows: readonly T[], context: string): T {
  const [row] = rows;
  if (row === undefined) {
    throw new DatabaseError(`Expected exactly one row for ${context}, got none`);
  }
  return row;
}
