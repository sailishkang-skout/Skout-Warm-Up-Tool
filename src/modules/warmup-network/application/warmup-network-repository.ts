import type { DatabaseClient } from "../../../shared/db/index.js";
import type { MailboxId, TenantId, WarmupNetworkDomainId, WarmupNetworkMailboxId } from "../../../shared/types/index.js";
import type { WarmupNetworkDomain } from "../domain/warmup-network-domain.js";
import type { WarmupNetworkMailbox } from "../domain/warmup-network-mailbox.js";
import type { WarmupNetworkRoutingDecision } from "../domain/warmup-network-routing.js";
import type { WarmupNetworkEntityStatus, WarmupNetworkInfraStatus } from "../domain/warmup-network-status.js";

export interface WarmupNetworkRecord {
  readonly id: string;
  readonly name: string;
  readonly status: WarmupNetworkInfraStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WarmupNetworkPoolRecord {
  readonly id: string;
  readonly networkId: string;
  readonly name: string;
  readonly status: WarmupNetworkInfraStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WarmupNetworkCandidate {
  readonly mailbox: WarmupNetworkMailbox;
  readonly domain: WarmupNetworkDomain;
  readonly linkedMailboxStatus: string;
  readonly linkedMailboxEnabled: boolean;
  readonly networkStatus: WarmupNetworkInfraStatus;
  readonly poolStatus: WarmupNetworkInfraStatus;
}

export interface InsertRoutingDecisionInput {
  readonly routingRequestKey: string;
  readonly customerTenantId: TenantId;
  readonly customerMailboxId: MailboxId;
  readonly selectedNetworkMailboxId?: WarmupNetworkMailboxId;
  readonly selectedDomainId?: WarmupNetworkDomainId;
  readonly outcome: WarmupNetworkRoutingDecision["outcome"];
  readonly reason: string;
  readonly eligibilitySummary: Record<string, unknown>;
}

export interface WarmupNetworkHealthSnapshot {
  readonly networks: number;
  readonly activeNetworks: number;
  readonly domains: number;
  readonly domainsByStatus: Readonly<Record<WarmupNetworkEntityStatus, number>>;
  readonly mailboxes: number;
  readonly mailboxesByStatus: Readonly<Record<WarmupNetworkEntityStatus, number>>;
  readonly credentialUnavailable: number;
  readonly remainingMailboxCapacityToday: number;
}

export interface WarmupNetworkRepository {
  findDecisionByRequestKey(client: DatabaseClient, routingRequestKey: string): Promise<WarmupNetworkRoutingDecision | undefined>;
  lockRoutingRequestKey(client: DatabaseClient, routingRequestKey: string): Promise<void>;
  lockCandidatesForUpdate(client: DatabaseClient): Promise<WarmupNetworkCandidate[]>;
  listRecentSelectedMailboxIds(
    client: DatabaseClient,
    customerMailboxId: MailboxId,
    since: Date,
  ): Promise<WarmupNetworkMailboxId[]>;
  insertDecision(client: DatabaseClient, input: InsertRoutingDecisionInput): Promise<WarmupNetworkRoutingDecision>;
  reserveUsage(
    client: DatabaseClient,
    mailboxId: WarmupNetworkMailboxId,
    domainId: WarmupNetworkDomainId,
    usageDate: string,
  ): Promise<boolean>;
  recordSuccessfulInteraction(mailboxId: WarmupNetworkMailboxId, at: Date): Promise<void>;
  markCredentialUnavailable(mailboxId: WarmupNetworkMailboxId, at: Date): Promise<void>;
  listDomains(): Promise<WarmupNetworkDomain[]>;
  getDomain(id: WarmupNetworkDomainId): Promise<WarmupNetworkDomain | undefined>;
  listMailboxes(): Promise<WarmupNetworkMailbox[]>;
  getMailbox(id: WarmupNetworkMailboxId, client?: DatabaseClient): Promise<WarmupNetworkMailbox | undefined>;
  getHealth(): Promise<WarmupNetworkHealthSnapshot>;
}
