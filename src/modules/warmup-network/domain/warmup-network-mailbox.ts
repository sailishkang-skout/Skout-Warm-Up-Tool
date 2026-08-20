import type { MailboxId, WarmupNetworkDomainId, WarmupNetworkMailboxId, WarmupNetworkPoolId } from "../../../shared/types/index.js";
import type {
  WarmupNetworkEntityStatus,
  WarmupNetworkProvider,
  WarmupNetworkReputationStatus,
} from "./warmup-network-status.js";

export interface WarmupNetworkMailbox {
  readonly id: WarmupNetworkMailboxId;
  readonly domainId: WarmupNetworkDomainId;
  readonly poolId: WarmupNetworkPoolId;
  readonly mailboxId: MailboxId;
  readonly provider: WarmupNetworkProvider;
  readonly providerMailboxIdentifier: string;
  readonly mailboxAddress: string;
  readonly status: WarmupNetworkEntityStatus;
  readonly healthScore: number;
  readonly reputationState: WarmupNetworkReputationStatus;
  readonly dailyCapacity: number;
  readonly usageDate: string;
  readonly usageCount: number;
  readonly lastSuccessfulInteractionAt?: Date;
  readonly lastFailureAt?: Date;
  readonly cooldownUntil?: Date;
  readonly credentialAvailable: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
