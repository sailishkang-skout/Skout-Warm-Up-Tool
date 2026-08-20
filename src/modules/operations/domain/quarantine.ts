export const QUARANTINE_SCOPES = ["MAILBOX", "DOMAIN", "PROVIDER_ACCOUNT", "NETWORK"] as const;
export type QuarantineScope = (typeof QUARANTINE_SCOPES)[number];

export interface OperationalQuarantine {
  readonly id: string;
  readonly scope: QuarantineScope;
  readonly scopeId: string;
  readonly tenantId?: string;
  readonly status: "ACTIVE" | "INACTIVE";
  readonly reason: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
