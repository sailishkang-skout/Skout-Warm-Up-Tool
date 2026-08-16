import { ConflictError } from "../../../shared/errors/index.js";
import type { MailboxStatus } from "./mailbox.js";

/**
 * The only place mailbox connection-state transitions are decided. Callers
 * (the application service) request a transition; they never assign
 * `status` directly. This is the literal transition graph:
 *
 *   PENDING      -> CONNECTING
 *   CONNECTING   -> CONNECTED, ERROR
 *   CONNECTED    -> DISCONNECTED, ERROR
 *   DISCONNECTED -> CONNECTING
 *   ERROR        -> CONNECTING, DISCONNECTED
 *
 * Every state can reach CONNECTING (retry/first attempt) except CONNECTING
 * itself. Nothing can jump straight to CONNECTED — it's only reachable by
 * attempting a connection from CONNECTING, never assigned directly.
 * DISCONNECTED is reachable from CONNECTED and ERROR (both represent "a
 * connection was attempted/active"); PENDING/CONNECTING cannot disconnect
 * directly since there is no active connection yet to tear down.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<MailboxStatus, readonly MailboxStatus[]>> = {
  PENDING: ["CONNECTING"],
  CONNECTING: ["CONNECTED", "ERROR"],
  CONNECTED: ["DISCONNECTED", "ERROR"],
  DISCONNECTED: ["CONNECTING"],
  ERROR: ["CONNECTING", "DISCONNECTED"],
};

export function canTransitionMailboxStatus(from: MailboxStatus, to: MailboxStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Throws `ConflictError` (safe to return to an API caller as-is) for any transition not in the graph above. */
export function assertValidMailboxTransition(from: MailboxStatus, to: MailboxStatus): void {
  if (!canTransitionMailboxStatus(from, to)) {
    throw new ConflictError(`Mailbox cannot transition from ${from} to ${to}`);
  }
}
