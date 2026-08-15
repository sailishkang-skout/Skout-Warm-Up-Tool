import { ValidationError } from "../../../shared/errors/index.js";

/**
 * Deliberately conservative: only lowercases and trims. Does NOT strip dots
 * or "+tag" suffixes from the local part — that's Gmail-specific
 * alias-folding behavior, not a general email property, and applying it
 * unconditionally here would incorrectly treat distinct mailboxes on other
 * providers (Microsoft 365, generic SMTP/IMAP) as duplicates. Gmail-specific
 * alias awareness belongs in the `providers` module (Stage 5+), operating on
 * top of this conservative canonical form — not baked into schema-level
 * uniqueness that every provider shares.
 */
export function canonicalizeEmailAddress(emailAddress: string): string {
  const trimmed = emailAddress.trim();
  const atIndex = trimmed.lastIndexOf("@");

  if (atIndex <= 0 || atIndex === trimmed.length - 1) {
    throw new ValidationError(`'${emailAddress}' is not a valid email address`);
  }

  const localPart = trimmed.slice(0, atIndex);
  const domainPart = trimmed.slice(atIndex + 1);

  return `${localPart.toLowerCase()}@${domainPart.toLowerCase()}`;
}
