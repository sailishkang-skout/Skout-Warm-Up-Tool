import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import {
  asWarmupNetworkDomainId,
  asWarmupNetworkMailboxId,
  type TenantId,
  type WarmupNetworkDomainId,
  type WarmupNetworkMailboxId,
} from "../../../shared/types/index.js";
import type { WarmupNetworkDomain } from "../domain/warmup-network-domain.js";
import type { WarmupNetworkMailbox } from "../domain/warmup-network-mailbox.js";
import type { WarmupNetworkService } from "../application/warmup-network-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function parseDomainId(rawId: string): WarmupNetworkDomainId {
  if (!UUID_PATTERN.test(rawId)) {
    throw new ValidationError("Invalid warmup network domain id");
  }
  return asWarmupNetworkDomainId(rawId);
}

function parseMailboxId(rawId: string): WarmupNetworkMailboxId {
  if (!UUID_PATTERN.test(rawId)) {
    throw new ValidationError("Invalid warmup network mailbox id");
  }
  return asWarmupNetworkMailboxId(rawId);
}

function toSafeDomain(domain: WarmupNetworkDomain) {
  return {
    id: domain.id,
    networkId: domain.networkId,
    poolId: domain.poolId,
    domain: domain.domain,
    provider: domain.provider,
    status: domain.status,
    authenticationStatus: domain.authenticationStatus,
    spfStatus: domain.spfStatus,
    dkimStatus: domain.dkimStatus,
    dmarcStatus: domain.dmarcStatus,
    reputationStatus: domain.reputationStatus,
    healthScore: domain.healthScore,
    capacityStatus: domain.capacityStatus,
    dailyCapacity: domain.dailyCapacity,
    usageDate: domain.usageDate,
    usageCount: domain.usageCount,
    ...(domain.cooldownUntil ? { cooldownUntil: domain.cooldownUntil.toISOString() } : {}),
    createdAt: domain.createdAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
  };
}

function toSafeMailbox(mailbox: WarmupNetworkMailbox) {
  return {
    id: mailbox.id,
    domainId: mailbox.domainId,
    poolId: mailbox.poolId,
    mailboxId: mailbox.mailboxId,
    provider: mailbox.provider,
    providerMailboxIdentifier: mailbox.providerMailboxIdentifier,
    status: mailbox.status,
    healthScore: mailbox.healthScore,
    reputationState: mailbox.reputationState,
    dailyCapacity: mailbox.dailyCapacity,
    usageDate: mailbox.usageDate,
    usageCount: mailbox.usageCount,
    credentialAvailable: mailbox.credentialAvailable,
    ...(mailbox.lastSuccessfulInteractionAt
      ? { lastSuccessfulInteractionAt: mailbox.lastSuccessfulInteractionAt.toISOString() }
      : {}),
    ...(mailbox.lastFailureAt ? { lastFailureAt: mailbox.lastFailureAt.toISOString() } : {}),
    ...(mailbox.cooldownUntil ? { cooldownUntil: mailbox.cooldownUntil.toISOString() } : {}),
    createdAt: mailbox.createdAt.toISOString(),
    updatedAt: mailbox.updatedAt.toISOString(),
  };
}

/**
 * Operator-facing read APIs for the global Skout-managed warmup network.
 * Authenticated tenants may read pool metadata; they cannot mutate it.
 * Never returns tokens or credential material.
 */
export function warmupNetworkRoutes(service: WarmupNetworkService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get("/domains", { preHandler: fastify.authenticate }, async (request) => {
      requireTenantId(request);
      const domains = await service.listDomains();
      return { domains: domains.map(toSafeDomain) };
    });

    fastify.get<{ Params: { id: string } }>("/domains/:id", { preHandler: fastify.authenticate }, async (request) => {
      requireTenantId(request);
      const domain = await service.getDomain(parseDomainId(request.params.id));
      return toSafeDomain(domain);
    });

    fastify.get("/mailboxes", { preHandler: fastify.authenticate }, async (request) => {
      requireTenantId(request);
      const mailboxes = await service.listMailboxes();
      return { mailboxes: mailboxes.map(toSafeMailbox) };
    });

    fastify.get<{ Params: { id: string } }>("/mailboxes/:id", { preHandler: fastify.authenticate }, async (request) => {
      requireTenantId(request);
      const mailbox = await service.getMailbox(parseMailboxId(request.params.id));
      return toSafeMailbox(mailbox);
    });

    fastify.get("/health", { preHandler: fastify.authenticate }, async (request) => {
      requireTenantId(request);
      return service.getHealth();
    });

    fastify.post<{ Params: { id: string } }>(
      "/mailboxes/:id/pause",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailbox = await service.pauseMembership(tenantId, parseMailboxId(request.params.id));
        return toSafeMailbox(mailbox);
      },
    );

    fastify.post<{ Params: { id: string } }>(
      "/mailboxes/:id/quarantine",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailbox = await service.quarantineMembership(tenantId, parseMailboxId(request.params.id));
        return toSafeMailbox(mailbox);
      },
    );
  };
}
