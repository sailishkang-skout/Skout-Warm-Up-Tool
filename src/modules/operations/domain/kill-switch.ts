export const KILL_SWITCH_SCOPES = ["GLOBAL", "PROVIDER", "NETWORK", "TENANT", "DOMAIN", "MAILBOX"] as const;
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

export const KILL_SWITCH_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type KillSwitchStatus = (typeof KILL_SWITCH_STATUSES)[number];

export interface KillSwitch {
  readonly id: string;
  readonly scope: KillSwitchScope;
  readonly scopeId: string;
  readonly status: KillSwitchStatus;
  readonly reason: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
