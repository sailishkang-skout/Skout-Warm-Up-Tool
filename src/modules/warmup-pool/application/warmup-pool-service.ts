import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { WarmupOperationResult, WarmupService } from "../../warmup/application/warmup-service.js";
import { ConflictError, NotFoundError, PolicyError, ValidationError } from "../../../shared/errors/index.js";
import type { Database } from "../../../shared/db/index.js";
import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import type { AppConfig } from "../../../shared/config/index.js";
import type { MailboxId, TenantId, WarmupPoolId } from "../../../shared/types/index.js";
import type { WarmupPool, WarmupPoolStatus, WarmupPoolStrategy } from "../domain/warmup-pool.js";
import type { WarmupPoolMembership, WarmupPoolMembershipStatus } from "../domain/warmup-pool-membership.js";
import { selectEligibleMailbox } from "./warmup-pool-eligibility.js";
import type { WarmupPoolHealthSnapshot, WarmupPoolRepository } from "./warmup-pool-repository.js";

export interface WarmupPoolSelection {
  readonly poolId: WarmupPoolId;
  readonly mailboxId: MailboxId;
  readonly domain: string;
  readonly previousMailboxId?: MailboxId;
  readonly reason: "SELECTED" | "ROTATED";
}

export interface WarmupPoolAllocateResult {
  readonly selection: WarmupPoolSelection;
  readonly warmup?: WarmupOperationResult;
}

export interface CreateWarmupPoolRequest {
  readonly name: string;
  readonly strategy?: WarmupPoolStrategy;
  readonly maxConsecutiveSameDomain?: number;
  readonly maxDomainSharePercent?: number;
}

export interface AddMailboxToPoolRequest {
  readonly mailboxId: MailboxId;
  readonly priority?: number;
  readonly weight?: number;
  readonly maxDailyWarmupVolume?: number;
  readonly status?: WarmupPoolMembershipStatus;
}

export interface PatchWarmupPoolRequest {
  readonly name?: string;
  readonly status?: WarmupPoolStatus;
  readonly strategy?: WarmupPoolStrategy;
  readonly maxConsecutiveSameDomain?: number;
  readonly maxDomainSharePercent?: number;
}

export interface WarmupPoolService {
  listPools(tenantId: TenantId): Promise<WarmupPool[]>;
  getPool(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPool>;
  createPool(tenantId: TenantId, input: CreateWarmupPoolRequest): Promise<WarmupPool>;
  patchPool(tenantId: TenantId, poolId: WarmupPoolId, input: PatchWarmupPoolRequest): Promise<WarmupPool>;
  listMailboxes(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPoolMembership[]>;
  addMailbox(tenantId: TenantId, poolId: WarmupPoolId, input: AddMailboxToPoolRequest): Promise<WarmupPoolMembership>;
  getHealth(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPoolHealthSnapshot>;
  selectNextMailbox(tenantId: TenantId, poolId: WarmupPoolId, now?: Date): Promise<WarmupPoolSelection>;
  allocateNext(tenantId: TenantId, poolId: WarmupPoolId, now?: Date): Promise<WarmupPoolAllocateResult>;
}

const MAX_RESELECT = 8;

export function createWarmupPoolService(deps: {
  readonly database: Database;
  readonly repository: WarmupPoolRepository;
  readonly mailboxService: MailboxService;
  readonly warmupService: WarmupService;
  readonly auditRecorder: AuditEventRecorder;
  readonly config: AppConfig["warmupPool"];
}): WarmupPoolService {
  const { database, repository, mailboxService, warmupService, auditRecorder, config } = deps;

  async function requirePool(tenantId: TenantId, poolId: WarmupPoolId): Promise<WarmupPool> {
    const pool = await repository.getPool(tenantId, poolId);
    if (!pool) {
      throw new NotFoundError("Warmup pool", poolId);
    }
    return pool;
  }

  async function selectLocked(
    tenantId: TenantId,
    poolId: WarmupPoolId,
    now: Date,
    excluded: ReadonlySet<string>,
  ): Promise<WarmupPoolSelection> {
    return database.withTransaction(async (client) => {
      const locked = await repository.lockPoolAndCandidates(client, tenantId, poolId);
      if (!locked) {
        throw new NotFoundError("Warmup pool", poolId);
      }
      const filtered = locked.candidates.filter((candidate) => !excluded.has(candidate.membership.mailboxId));
      const { selected, skipped } = selectEligibleMailbox(filtered, locked.pool, now);
      for (const skip of skipped) {
        const healthSkip = skip.reasons.some(
          (reason) =>
            reason === "MAILBOX_UNHEALTHY" ||
            reason === "PROVIDER_UNHEALTHY" ||
            reason === "DOMAIN_HEALTH_UNKNOWN" ||
            reason === "DOMAIN_HEALTH_BLOCKED",
        );
        const domainSkip = skip.reasons.includes("DOMAIN_CONCENTRATION");
        if (healthSkip) {
          incrementCounter(METRIC.warmupPoolHealthSkipped);
        }
        if (domainSkip) {
          incrementCounter(METRIC.warmupPoolDomainSkipped);
        }
        await auditRecorder.record({
          tenantId,
          eventType: "WARMUP_MAILBOX_SKIPPED",
          actorType: "system",
          metadata: {
            tenantId,
            poolId,
            mailboxId: skip.candidate.membership.mailboxId,
            domain: skip.candidate.emailDomain,
            reason: skip.reasons.join(","),
          },
        });
      }
      if (!selected) {
        incrementCounter(METRIC.warmupPoolNoEligibleMailbox);
        incrementCounter(METRIC.warmupPoolSelectionFailed);
        await auditRecorder.record({
          tenantId,
          eventType: "WARMUP_POOL_EXHAUSTED",
          actorType: "system",
          metadata: { tenantId, poolId, reason: "NO_ELIGIBLE_WARMUP_MAILBOX" },
        });
        throw new PolicyError("NO_ELIGIBLE_WARMUP_MAILBOX", { details: { poolId } });
      }
      const cooldownUntil =
        config.selectionCooldownMs > 0 ? new Date(now.getTime() + config.selectionCooldownMs) : undefined;
      await repository.applySelection(client, {
        tenantId,
        poolId,
        membershipId: selected.membership.id,
        mailboxId: selected.membership.mailboxId,
        domain: selected.emailDomain,
        now,
        ...(cooldownUntil ? { cooldownUntil } : {}),
      });
      const rotated =
        locked.pool.lastSelectedMailboxId !== undefined &&
        locked.pool.lastSelectedMailboxId !== selected.membership.mailboxId;
      incrementCounter(METRIC.warmupPoolSelection);
      if (rotated) {
        incrementCounter(METRIC.warmupPoolRotation);
      }
      await auditRecorder.record({
        tenantId,
        eventType: rotated ? "WARMUP_MAILBOX_ROTATED" : "WARMUP_MAILBOX_SELECTED",
        actorType: "system",
        metadata: {
          tenantId,
          poolId,
          mailboxId: selected.membership.mailboxId,
          domain: selected.emailDomain,
          reason: rotated ? "ROTATED" : "SELECTED",
          previousMailboxId: locked.pool.lastSelectedMailboxId,
          newMailboxId: selected.membership.mailboxId,
        },
      });
      return {
        poolId,
        mailboxId: selected.membership.mailboxId,
        domain: selected.emailDomain,
        ...(locked.pool.lastSelectedMailboxId ? { previousMailboxId: locked.pool.lastSelectedMailboxId } : {}),
        reason: rotated ? "ROTATED" : "SELECTED",
      };
    });
  }

  return {
    listPools: (tenantId) => repository.listPools(tenantId),
    async getPool(tenantId, poolId) {
      return requirePool(tenantId, poolId);
    },
    async createPool(tenantId, input) {
      const name = input.name.trim();
      if (name.length === 0) {
        throw new ValidationError("Pool name is required");
      }
      return repository.createPool({
        tenantId,
        name,
        strategy: input.strategy ?? config.selectionStrategy,
        maxConsecutiveSameDomain: input.maxConsecutiveSameDomain ?? config.maxConsecutiveSameDomain,
        maxDomainSharePercent: input.maxDomainSharePercent ?? config.maxDomainSharePercent,
      });
    },
    async patchPool(tenantId, poolId, input) {
      const updated = await repository.patchPool(tenantId, poolId, input);
      if (!updated) {
        throw new NotFoundError("Warmup pool", poolId);
      }
      return updated;
    },
    async listMailboxes(tenantId, poolId) {
      await requirePool(tenantId, poolId);
      return repository.listMemberships(tenantId, poolId);
    },
    async addMailbox(tenantId, poolId, input) {
      await requirePool(tenantId, poolId);
      await mailboxService.getMailbox(tenantId, input.mailboxId);
      try {
        return await repository.addMembership({
          tenantId,
          poolId,
          mailboxId: input.mailboxId,
          ...(input.status ? { status: input.status } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.weight !== undefined ? { weight: input.weight } : {}),
          ...(input.maxDailyWarmupVolume !== undefined ? { maxDailyWarmupVolume: input.maxDailyWarmupVolume } : {}),
        });
      } catch (error) {
        if (
          error instanceof ConflictError &&
          error.details?.constraint === "warmup_pool_memberships_pool_mailbox_unique"
        ) {
          throw new ConflictError("Mailbox is already in this warmup pool");
        }
        throw error;
      }
    },
    async getHealth(tenantId, poolId) {
      const health = await repository.getHealth(tenantId, poolId);
      if (!health) {
        throw new NotFoundError("Warmup pool", poolId);
      }
      return health;
    },
    async selectNextMailbox(tenantId, poolId, now = new Date()) {
      return selectLocked(tenantId, poolId, now, new Set());
    },
    async allocateNext(tenantId, poolId, now = new Date()) {
      const excluded = new Set<string>();
      let lastSelection: WarmupPoolSelection | undefined;
      for (let attempt = 0; attempt < MAX_RESELECT; attempt += 1) {
        const selection = await selectLocked(tenantId, poolId, now, excluded);
        lastSelection = selection;
        try {
          const warmup = await warmupService.advanceDailyWarmup(tenantId, selection.mailboxId);
          if (warmup.intent) {
            return { selection, warmup };
          }
          excluded.add(selection.mailboxId);
          await auditRecorder.record({
            tenantId,
            eventType: "WARMUP_MAILBOX_SKIPPED",
            actorType: "system",
            metadata: {
              tenantId,
              poolId,
              mailboxId: selection.mailboxId,
              domain: selection.domain,
              reason: "NO_INTENT_AFTER_SAFETY_GATE",
            },
          });
        } catch (error) {
          if (error instanceof PolicyError || error instanceof NotFoundError) {
            excluded.add(selection.mailboxId);
            await auditRecorder.record({
              tenantId,
              eventType: "WARMUP_MAILBOX_SKIPPED",
              actorType: "system",
              metadata: {
                tenantId,
                poolId,
                mailboxId: selection.mailboxId,
                domain: selection.domain,
                reason: error instanceof PolicyError ? "POLICY" : "NO_ACTIVE_SESSION",
              },
            });
            continue;
          }
          throw error;
        }
      }
      if (lastSelection) {
        return { selection: lastSelection };
      }
      throw new PolicyError("NO_ELIGIBLE_WARMUP_MAILBOX", { details: { poolId } });
    },
  };
}
