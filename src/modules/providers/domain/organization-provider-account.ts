import type { TenantId } from "../../../shared/types/index.js";

export interface OrganizationProviderAccount {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly customerDomainId?: string;
  readonly provider: "GMAIL" | "MICROSOFT365";
  readonly providerCustomerId?: string;
  readonly customerDomain: string;
  readonly status: "PENDING" | "ACTIVE" | "ERROR" | "SUSPENDED";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
