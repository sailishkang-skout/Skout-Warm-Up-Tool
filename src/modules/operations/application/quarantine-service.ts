import type { Database } from "../../../shared/db/index.js";
import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { OperationalQuarantine, QuarantineScope } from "../domain/quarantine.js";

export interface SendBlockContext {
  readonly tenantId: string;
  readonly mailboxId: string;
  readonly provider: string;
  readonly domainId?: string;
  readonly providerAccountId?: string;
  readonly networkId?: string;
}

export interface QuarantineService {
  isSendBlocked(context: SendBlockContext): Promise<boolean>;
  activate(
    scope: QuarantineScope,
    scopeId: string,
    reason: string,
    tenantId?: string,
  ): Promise<OperationalQuarantine>;
  deactivate(scope: QuarantineScope, scopeId: string, reason: string): Promise<OperationalQuarantine | undefined>;
  listActive(): Promise<OperationalQuarantine[]>;
}

export function createQuarantineService(deps: {
  readonly database: Database;
  readonly auditRecorder: AuditEventRecorder;
}): QuarantineService {
  return {
    async isSendBlocked(context) {
      const pairs: Array<{ scope: QuarantineScope; id: string }> = [{ scope: "MAILBOX", id: context.mailboxId }];
      if (context.domainId) {
        pairs.push({ scope: "DOMAIN", id: context.domainId });
      }
      if (context.providerAccountId) {
        pairs.push({ scope: "PROVIDER_ACCOUNT", id: context.providerAccountId });
      }
      if (context.networkId) {
        pairs.push({ scope: "NETWORK", id: context.networkId });
      }
      const rows = await deps.database.query<{ id: string }>(
        `SELECT id FROM operational_quarantines
          WHERE status = 'ACTIVE'
            AND (${pairs.map((_, index) => `(scope = $${index * 2 + 1} AND scope_id = $${index * 2 + 2})`).join(" OR ")})
          LIMIT 1`,
        pairs.flatMap((pair) => [pair.scope, pair.id]),
      );
      return rows.length > 0;
    },

    async activate(scope, scopeId, reason, tenantId) {
      const rows = await deps.database.query<Row>(
        `INSERT INTO operational_quarantines (scope, scope_id, tenant_id, status, reason)
         VALUES ($1, $2, $3, 'ACTIVE', $4)
         ON CONFLICT (scope, scope_id)
         DO UPDATE SET status = 'ACTIVE', reason = EXCLUDED.reason, tenant_id = COALESCE(EXCLUDED.tenant_id, operational_quarantines.tenant_id)
         RETURNING id, scope, scope_id, tenant_id, status, reason, created_at, updated_at`,
        [scope, scopeId, tenantId ?? null, reason],
      );
      incrementCounter(METRIC.quarantineActivated);
      await deps.auditRecorder.record({
        ...(tenantId ? { tenantId: tenantId as never } : {}),
        eventType: scope === "MAILBOX" ? "MAILBOX_QUARANTINED" : "NETWORK_QUARANTINED",
        actorType: "system",
        metadata: { scope, scopeId, reason },
      });
      return mapRow(rows[0]!);
    },

    async deactivate(scope, scopeId, reason) {
      const rows = await deps.database.query<Row>(
        `UPDATE operational_quarantines
            SET status = 'INACTIVE', reason = $3
          WHERE scope = $1 AND scope_id = $2
          RETURNING id, scope, scope_id, tenant_id, status, reason, created_at, updated_at`,
        [scope, scopeId, reason],
      );
      if (!rows[0]) {
        return undefined;
      }
      return mapRow(rows[0]);
    },

    async listActive() {
      const rows = await deps.database.query<Row>(
        `SELECT id, scope, scope_id, tenant_id, status, reason, created_at, updated_at
           FROM operational_quarantines WHERE status = 'ACTIVE' ORDER BY created_at`,
      );
      return rows.map(mapRow);
    },
  };
}

interface Row {
  id: string;
  scope: QuarantineScope;
  scope_id: string;
  tenant_id: string | null;
  status: "ACTIVE" | "INACTIVE";
  reason: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: Row): OperationalQuarantine {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
