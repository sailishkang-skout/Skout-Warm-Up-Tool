import type { TenantId } from "../../../shared/types/index.js";

export const TENANT_STATUSES = ["ACTIVE", "SUSPENDED", "DELETED"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  readonly status: TenantStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
