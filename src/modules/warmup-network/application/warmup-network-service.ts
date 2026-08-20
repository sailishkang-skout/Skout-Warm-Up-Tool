import { NotFoundError } from "../../../shared/errors/index.js";
import type { TenantId, WarmupNetworkDomainId, WarmupNetworkMailboxId } from "../../../shared/types/index.js";
import type { WarmupNetworkDomain } from "../domain/warmup-network-domain.js";
import type { WarmupNetworkMailbox } from "../domain/warmup-network-mailbox.js";
import type { WarmupNetworkHealthSnapshot, WarmupNetworkRepository } from "./warmup-network-repository.js";

export interface WarmupNetworkService {
  listDomains(): Promise<WarmupNetworkDomain[]>;
  getDomain(id: WarmupNetworkDomainId): Promise<WarmupNetworkDomain>;
  listMailboxes(): Promise<WarmupNetworkMailbox[]>;
  getMailbox(id: WarmupNetworkMailboxId): Promise<WarmupNetworkMailbox>;
  getHealth(): Promise<WarmupNetworkHealthSnapshot>;
  pauseMembership(tenantId: TenantId, id: WarmupNetworkMailboxId): Promise<WarmupNetworkMailbox>;
  resumeMembership(tenantId: TenantId, id: WarmupNetworkMailboxId): Promise<WarmupNetworkMailbox>;
  quarantineMembership(tenantId: TenantId, id: WarmupNetworkMailboxId): Promise<WarmupNetworkMailbox>;
  grantConsent(tenantId: TenantId, id: WarmupNetworkMailboxId): Promise<WarmupNetworkMailbox>;
  revokeConsent(tenantId: TenantId, id: WarmupNetworkMailboxId): Promise<WarmupNetworkMailbox>;
}

export function createWarmupNetworkService(repository: WarmupNetworkRepository): WarmupNetworkService {
  return {
    listDomains: () => repository.listDomains(),
    async getDomain(id) {
      const domain = await repository.getDomain(id);
      if (!domain) {
        throw new NotFoundError("Warmup network domain not found");
      }
      return domain;
    },
    listMailboxes: () => repository.listMailboxes(),
    async getMailbox(id) {
      const mailbox = await repository.getMailbox(id);
      if (!mailbox) {
        throw new NotFoundError("Warmup network mailbox not found");
      }
      return mailbox;
    },
    getHealth: () => repository.getHealth(),
    async pauseMembership(tenantId, id) {
      const mailbox = await repository.updateMembershipStatus(id, tenantId, "PAUSED");
      if (!mailbox) {
        throw new NotFoundError("Warmup network mailbox not found");
      }
      return mailbox;
    },
    async quarantineMembership(tenantId, id) {
      const mailbox = await repository.updateMembershipStatus(id, tenantId, "QUARANTINED");
      if (!mailbox) {
        throw new NotFoundError("Warmup network mailbox not found");
      }
      return mailbox;
    },
    async resumeMembership(tenantId, id) {
      const mailbox = await repository.updateMembershipStatus(id, tenantId, "ACTIVE");
      if (!mailbox) {
        throw new NotFoundError("Warmup network mailbox not found");
      }
      return mailbox;
    },
    async grantConsent(tenantId, id) {
      const mailbox = await repository.updateMembershipStatus(id, tenantId, "ACTIVE");
      if (!mailbox) {
        throw new NotFoundError("Warmup network mailbox not found");
      }
      return mailbox;
    },
    async revokeConsent(tenantId, id) {
      const mailbox = await repository.updateMembershipStatus(id, tenantId, "REMOVED");
      if (!mailbox) {
        throw new NotFoundError("Warmup network mailbox not found");
      }
      return mailbox;
    },
  };
}
