import type { Database } from "../../../shared/db/index.js";
import { ConflictError } from "../../../shared/errors/index.js";
import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import { canTransitionOperationalStatus, type MailboxOperationalStatus } from "../domain/mailbox-operational-status.js";

export interface MailboxOperationalState {
  readonly mailboxId: string;
  readonly tenantId: string;
  readonly status: MailboxOperationalStatus;
  readonly updatedAt: Date;
}

export interface MailboxOperationalStateService {
  get(tenantId: string, mailboxId: string): Promise<MailboxOperationalState>;
  ensure(tenantId: string, mailboxId: string, status?: MailboxOperationalStatus): Promise<MailboxOperationalState>;
  transition(tenantId: string, mailboxId: string, to: MailboxOperationalStatus): Promise<MailboxOperationalState>;
}

export function createMailboxOperationalStateService(deps: {
  readonly database: Database;
  readonly auditRecorder: AuditEventRecorder;
}): MailboxOperationalStateService {
  return {
    async get(tenantId, mailboxId) {
      const rows = await deps.database.query<Row>(
        `SELECT mailbox_id, tenant_id, status, updated_at
           FROM mailbox_operational_states
          WHERE tenant_id = $1 AND mailbox_id = $2`,
        [tenantId, mailboxId],
      );
      if (rows[0]) {
        return mapRow(rows[0]);
      }
      return this.ensure(tenantId, mailboxId, "DISCOVERED");
    },

    async ensure(tenantId, mailboxId, status = "DISCOVERED") {
      const rows = await deps.database.query<Row>(
        `INSERT INTO mailbox_operational_states (mailbox_id, tenant_id, status)
         VALUES ($1, $2, $3)
         ON CONFLICT (mailbox_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
         RETURNING mailbox_id, tenant_id, status, updated_at`,
        [mailboxId, tenantId, status],
      );
      return mapRow(rows[0]!);
    },

    async transition(tenantId, mailboxId, to) {
      const current = await this.get(tenantId, mailboxId);
      if (current.status === to) {
        return current;
      }
      if (!canTransitionOperationalStatus(current.status, to)) {
        throw new ConflictError(`Mailbox operational status cannot move from ${current.status} to ${to}`);
      }
      const rows = await deps.database.query<Row>(
        `UPDATE mailbox_operational_states
            SET status = $3
          WHERE tenant_id = $1 AND mailbox_id = $2
          RETURNING mailbox_id, tenant_id, status, updated_at`,
        [tenantId, mailboxId, to],
      );
      const next = mapRow(rows[0]!);
      await deps.auditRecorder.record({
        tenantId: tenantId as never,
        eventType: "MAILBOX_OPERATIONAL_STATUS_CHANGED",
        actorType: "system",
        metadata: { mailboxId, from: current.status, to },
      });
      incrementCounter(METRIC.mailboxOperationalTransition);
      return next;
    },
  };
}

interface Row {
  mailbox_id: string;
  tenant_id: string;
  status: MailboxOperationalStatus;
  updated_at: Date;
}

function mapRow(row: Row): MailboxOperationalState {
  return {
    mailboxId: row.mailbox_id,
    tenantId: row.tenant_id,
    status: row.status,
    updatedAt: row.updated_at,
  };
}
