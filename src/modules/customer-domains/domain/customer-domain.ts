import type { TenantId } from "../../../shared/types/index.js";

export const CUSTOMER_DOMAIN_STATUSES = [
  "DISCOVERED",
  "PENDING_VERIFICATION",
  "VERIFIED",
  "CONFIGURING",
  "READY",
  "DEGRADED",
  "SUSPENDED",
] as const;
export type CustomerDomainStatus = (typeof CUSTOMER_DOMAIN_STATUSES)[number];

export interface CustomerDomain {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly domainName: string;
  readonly status: CustomerDomainStatus;
  readonly verificationStatus: "UNVERIFIED" | "PENDING" | "VERIFIED" | "FAILED";
  readonly provider: "GMAIL" | "MICROSOFT365" | "UNKNOWN";
  readonly dnsStatus: string;
  readonly spfStatus: string;
  readonly dkimStatus: string;
  readonly dmarcStatus: string;
  readonly mxStatus: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
