import type { WarmupNetworkDomainId, WarmupNetworkId, WarmupNetworkPoolId } from "../../../shared/types/index.js";
import type {
  WarmupNetworkAuthStatus,
  WarmupNetworkCapacityStatus,
  WarmupNetworkEntityStatus,
  WarmupNetworkProvider,
  WarmupNetworkReputationStatus,
} from "./warmup-network-status.js";

export interface WarmupNetworkDomain {
  readonly id: WarmupNetworkDomainId;
  readonly networkId: WarmupNetworkId;
  readonly poolId: WarmupNetworkPoolId;
  readonly domain: string;
  readonly provider: WarmupNetworkProvider;
  readonly status: WarmupNetworkEntityStatus;
  readonly authenticationStatus: WarmupNetworkAuthStatus;
  readonly spfStatus: WarmupNetworkAuthStatus;
  readonly dkimStatus: WarmupNetworkAuthStatus;
  readonly dmarcStatus: WarmupNetworkAuthStatus;
  readonly reputationStatus: WarmupNetworkReputationStatus;
  readonly healthScore: number;
  readonly capacityStatus: WarmupNetworkCapacityStatus;
  readonly dailyCapacity: number;
  readonly usageDate: string;
  readonly usageCount: number;
  readonly cooldownUntil?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
