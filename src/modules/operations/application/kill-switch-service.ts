import type { Database } from "../../../shared/db/index.js";
import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { KillSwitch, KillSwitchScope } from "../domain/kill-switch.js";

export interface KillSwitchService {
  isGlobalPaused(): Promise<boolean>;
  activate(scope: KillSwitchScope, scopeId: string, reason: string): Promise<KillSwitch>;
  deactivate(scope: KillSwitchScope, scopeId: string, reason: string): Promise<KillSwitch | undefined>;
  listActive(): Promise<KillSwitch[]>;
}

export function createKillSwitchService(deps: {
  readonly database: Database;
  readonly auditRecorder: AuditEventRecorder;
  readonly envGlobalPause: boolean;
}): KillSwitchService {
  return {
    async isGlobalPaused() {
      if (deps.envGlobalPause) {
        return true;
      }
      const rows = await deps.database.query<{ id: string }>(
        `SELECT id FROM operational_kill_switches WHERE scope = 'GLOBAL' AND status = 'ACTIVE' LIMIT 1`,
      );
      return rows.length > 0;
    },

    async activate(scope, scopeId, reason) {
      const rows = await deps.database.query<KillSwitchRow>(
        `INSERT INTO operational_kill_switches (scope, scope_id, status, reason)
         VALUES ($1, $2, 'ACTIVE', $3)
         ON CONFLICT (scope, scope_id)
         DO UPDATE SET status = 'ACTIVE', reason = EXCLUDED.reason
         RETURNING id, scope, scope_id, status, reason, created_at, updated_at`,
        [scope, scopeId, reason],
      );
      const row = rows[0]!;
      incrementCounter(METRIC.killSwitchActivated);
      await deps.auditRecorder.record({
        eventType: "KILL_SWITCH_ACTIVATED",
        actorType: "system",
        metadata: { scope, scopeId, reason },
      });
      return mapKillSwitch(row);
    },

    async deactivate(scope, scopeId, reason) {
      const rows = await deps.database.query<KillSwitchRow>(
        `UPDATE operational_kill_switches
            SET status = 'INACTIVE', reason = $3
          WHERE scope = $1 AND scope_id = $2
          RETURNING id, scope, scope_id, status, reason, created_at, updated_at`,
        [scope, scopeId, reason],
      );
      if (!rows[0]) {
        return undefined;
      }
      await deps.auditRecorder.record({
        eventType: "KILL_SWITCH_ACTIVATED",
        actorType: "system",
        metadata: { scope, scopeId, reason, status: "INACTIVE" },
      });
      return mapKillSwitch(rows[0]);
    },

    async listActive() {
      const rows = await deps.database.query<KillSwitchRow>(
        `SELECT id, scope, scope_id, status, reason, created_at, updated_at
           FROM operational_kill_switches WHERE status = 'ACTIVE' ORDER BY created_at`,
      );
      return rows.map(mapKillSwitch);
    },
  };
}

interface KillSwitchRow {
  id: string;
  scope: KillSwitch["scope"];
  scope_id: string;
  status: KillSwitch["status"];
  reason: string;
  created_at: Date;
  updated_at: Date;
}

function mapKillSwitch(row: KillSwitchRow): KillSwitch {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
