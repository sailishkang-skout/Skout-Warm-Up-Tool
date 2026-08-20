import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import {
  asMailboxId,
  asWarmupPoolId,
  type MailboxId,
  type TenantId,
  type WarmupPoolId,
} from "../../../shared/types/index.js";
import { WARMUP_POOL_STATUSES, WARMUP_POOL_STRATEGIES, type WarmupPool } from "../domain/warmup-pool.js";
import { WARMUP_POOL_MEMBERSHIP_STATUSES, type WarmupPoolMembership } from "../domain/warmup-pool-membership.js";
import type { WarmupPoolService } from "../application/warmup-pool-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function parsePoolId(rawId: string): WarmupPoolId {
  if (!UUID_PATTERN.test(rawId)) {
    throw new ValidationError("Invalid warmup pool id");
  }
  return asWarmupPoolId(rawId);
}

function parseMailboxId(rawId: string): MailboxId {
  if (!UUID_PATTERN.test(rawId)) {
    throw new ValidationError("Invalid mailbox id");
  }
  return asMailboxId(rawId);
}

const createPoolBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  strategy: z.enum(WARMUP_POOL_STRATEGIES).optional(),
  maxConsecutiveSameDomain: z.number().int().min(1).max(100).optional(),
  maxDomainSharePercent: z.number().int().min(1).max(100).optional(),
});

const patchPoolBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(WARMUP_POOL_STATUSES).optional(),
  strategy: z.enum(WARMUP_POOL_STRATEGIES).optional(),
  maxConsecutiveSameDomain: z.number().int().min(1).max(100).optional(),
  maxDomainSharePercent: z.number().int().min(1).max(100).optional(),
});

const addMailboxBodySchema = z.object({
  mailboxId: z.string().uuid(),
  priority: z.number().int().optional(),
  weight: z.number().int().min(1).max(10_000).optional(),
  maxDailyWarmupVolume: z.number().int().min(0).optional(),
  status: z.enum(WARMUP_POOL_MEMBERSHIP_STATUSES).optional(),
});

function toSafePool(pool: WarmupPool) {
  return {
    id: pool.id,
    name: pool.name,
    status: pool.status,
    strategy: pool.strategy,
    maxConsecutiveSameDomain: pool.maxConsecutiveSameDomain,
    maxDomainSharePercent: pool.maxDomainSharePercent,
    ...(pool.lastSelectedMailboxId ? { lastSelectedMailboxId: pool.lastSelectedMailboxId } : {}),
    ...(pool.lastSelectedDomain ? { lastSelectedDomain: pool.lastSelectedDomain } : {}),
    consecutiveSameDomain: pool.consecutiveSameDomain,
    createdAt: pool.createdAt.toISOString(),
    updatedAt: pool.updatedAt.toISOString(),
  };
}

function toSafeMembership(membership: WarmupPoolMembership) {
  return {
    id: membership.id,
    poolId: membership.poolId,
    mailboxId: membership.mailboxId,
    status: membership.status,
    priority: membership.priority,
    weight: membership.weight,
    ...(membership.maxDailyWarmupVolume !== undefined ? { maxDailyWarmupVolume: membership.maxDailyWarmupVolume } : {}),
    currentDailyWarmupVolume: membership.currentDailyWarmupVolume,
    usageDate: membership.usageDate,
    ...(membership.lastSelectedAt ? { lastSelectedAt: membership.lastSelectedAt.toISOString() } : {}),
    ...(membership.cooldownUntil ? { cooldownUntil: membership.cooldownUntil.toISOString() } : {}),
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  };
}

/**
 * Tenant-scoped sending-identity pool APIs. Authenticated only. Never
 * returns credentials. Distinct from `/api/v1/warmup-network` (partner recipients).
 */
export function warmupPoolRoutes(service: WarmupPoolService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get("/pools", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const pools = await service.listPools(tenantId);
      return { pools: pools.map(toSafePool) };
    });

    fastify.post("/pools", { preHandler: fastify.authenticate }, async (request, reply) => {
      const tenantId = requireTenantId(request);
      const parsed = createPoolBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid warmup pool", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const pool = await service.createPool(tenantId, {
        name: parsed.data.name,
        ...(parsed.data.strategy ? { strategy: parsed.data.strategy } : {}),
        ...(parsed.data.maxConsecutiveSameDomain !== undefined
          ? { maxConsecutiveSameDomain: parsed.data.maxConsecutiveSameDomain }
          : {}),
        ...(parsed.data.maxDomainSharePercent !== undefined
          ? { maxDomainSharePercent: parsed.data.maxDomainSharePercent }
          : {}),
      });
      reply.status(201);
      return toSafePool(pool);
    });

    fastify.get<{ Params: { poolId: string } }>("/pools/:poolId", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const pool = await service.getPool(tenantId, parsePoolId(request.params.poolId));
      return toSafePool(pool);
    });

    fastify.patch<{ Params: { poolId: string } }>("/pools/:poolId", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const parsed = patchPoolBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid warmup pool patch", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const pool = await service.patchPool(tenantId, parsePoolId(request.params.poolId), {
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.strategy ? { strategy: parsed.data.strategy } : {}),
        ...(parsed.data.maxConsecutiveSameDomain !== undefined
          ? { maxConsecutiveSameDomain: parsed.data.maxConsecutiveSameDomain }
          : {}),
        ...(parsed.data.maxDomainSharePercent !== undefined
          ? { maxDomainSharePercent: parsed.data.maxDomainSharePercent }
          : {}),
      });
      return toSafePool(pool);
    });

    fastify.get<{ Params: { poolId: string } }>(
      "/pools/:poolId/mailboxes",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailboxes = await service.listMailboxes(tenantId, parsePoolId(request.params.poolId));
        return { mailboxes: mailboxes.map(toSafeMembership) };
      },
    );

    fastify.post<{ Params: { poolId: string } }>(
      "/pools/:poolId/mailboxes",
      { preHandler: fastify.authenticate },
      async (request, reply) => {
        const tenantId = requireTenantId(request);
        const parsed = addMailboxBodySchema.safeParse(request.body);
        if (!parsed.success) {
          throw new ValidationError("Invalid pool mailbox", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
        }
        const membership = await service.addMailbox(tenantId, parsePoolId(request.params.poolId), {
          mailboxId: parseMailboxId(parsed.data.mailboxId),
          ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
          ...(parsed.data.weight !== undefined ? { weight: parsed.data.weight } : {}),
          ...(parsed.data.maxDailyWarmupVolume !== undefined
            ? { maxDailyWarmupVolume: parsed.data.maxDailyWarmupVolume }
            : {}),
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
        });
        reply.status(201);
        return toSafeMembership(membership);
      },
    );

    fastify.get<{ Params: { poolId: string } }>(
      "/pools/:poolId/health",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        return service.getHealth(tenantId, parsePoolId(request.params.poolId));
      },
    );

    fastify.post<{ Params: { poolId: string } }>(
      "/pools/:poolId/select",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        return service.selectNextMailbox(tenantId, parsePoolId(request.params.poolId));
      },
    );

    fastify.post<{ Params: { poolId: string } }>(
      "/pools/:poolId/allocate",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const result = await service.allocateNext(tenantId, parsePoolId(request.params.poolId));
        return {
          selection: result.selection,
          ...(result.warmup
            ? {
                sessionId: result.warmup.session.id,
                mailboxId: result.warmup.session.mailboxId,
                ...(result.warmup.intent ? { intentId: result.warmup.intent.id } : {}),
              }
            : {}),
        };
      },
    );
  };
}
