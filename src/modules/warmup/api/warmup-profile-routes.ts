import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, NotFoundError, ValidationError } from "../../../shared/errors/index.js";
import { asMailboxId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { WarmupProfile } from "../domain/warmup-profile.js";
import type { WarmupProfileService } from "../application/warmup-profile-service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

function parseMailboxId(rawId: string): MailboxId {
  if (!UUID_PATTERN.test(rawId)) {
    throw new ValidationError("Invalid mailbox id");
  }
  return asMailboxId(rawId);
}

// Deliberately no `active` field anywhere in these schemas — Stage 9 spec
// section 12: "Do not expose `active` as a freely mutable profile field."
// A client sending one is silently ignored (zod strips unknown keys by
// default), never accepted.
const createProfileSchema = z.object({
  targetDailyVolume: z.number().int().min(0),
  startingDailyVolume: z.number().int().min(0),
  maximumDailyVolume: z.number().int().min(0),
  rampStrategy: z.enum(["CONSERVATIVE", "STANDARD", "AGGRESSIVE"]),
  riskTolerance: z.enum(["LOW", "MEDIUM", "HIGH"]),
  pauseConditions: z.array(z.string()).optional(),
});

const updateProfileSchema = z
  .object({
    targetDailyVolume: z.number().int().min(0).optional(),
    startingDailyVolume: z.number().int().min(0).optional(),
    maximumDailyVolume: z.number().int().min(0).optional(),
    rampStrategy: z.enum(["CONSERVATIVE", "STANDARD", "AGGRESSIVE"]).optional(),
    riskTolerance: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
    pauseConditions: z.array(z.string()).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "At least one field must be provided" });

function toSafeProfileResponse(profile: WarmupProfile) {
  return {
    id: profile.id,
    mailboxId: profile.mailboxId,
    targetDailyVolume: profile.targetDailyVolume,
    startingDailyVolume: profile.startingDailyVolume,
    maximumDailyVolume: profile.maximumDailyVolume,
    rampStrategy: profile.rampStrategy,
    riskTolerance: profile.riskTolerance,
    active: profile.active,
    pauseConditions: profile.pauseConditions,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

/**
 * Registered under /api/v1/mailboxes. Configuration only — `active`,
 * session/decision/intent/lease state are never reachable here; those
 * remain `WarmupService`'s exclusive authority (Stage 9 spec section 12:
 * "WarmupService remains the authority for: start, pause, resume, stop").
 * `tenantId`/`mailboxId` are always server-derived (route param + auth
 * context), never accepted from a request body.
 */
export function warmupProfileRoutes(warmupProfileService: WarmupProfileService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get<{ Params: { id: string } }>("/:id/warmup/profile", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const mailboxId = parseMailboxId(request.params.id);
      const profile = await warmupProfileService.getProfile(tenantId, mailboxId);
      if (!profile) {
        throw new NotFoundError("Warmup profile for mailbox", mailboxId);
      }
      return toSafeProfileResponse(profile);
    });

    fastify.post<{ Params: { id: string } }>("/:id/warmup/profile", { preHandler: fastify.authenticate }, async (request, reply) => {
      const tenantId = requireTenantId(request);
      const mailboxId = parseMailboxId(request.params.id);
      const parsed = createProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid warmup profile", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const { pauseConditions, ...rest } = parsed.data;
      const profile = await warmupProfileService.createProfile(tenantId, mailboxId, {
        ...rest,
        ...(pauseConditions ? { pauseConditions } : {}),
      });
      reply.status(201);
      return toSafeProfileResponse(profile);
    });

    fastify.patch<{ Params: { id: string } }>("/:id/warmup/profile", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const mailboxId = parseMailboxId(request.params.id);
      const parsed = updateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid warmup profile update", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const { targetDailyVolume, startingDailyVolume, maximumDailyVolume, rampStrategy, riskTolerance, pauseConditions } = parsed.data;
      const profile = await warmupProfileService.updateProfile(tenantId, mailboxId, {
        ...(targetDailyVolume !== undefined ? { targetDailyVolume } : {}),
        ...(startingDailyVolume !== undefined ? { startingDailyVolume } : {}),
        ...(maximumDailyVolume !== undefined ? { maximumDailyVolume } : {}),
        ...(rampStrategy !== undefined ? { rampStrategy } : {}),
        ...(riskTolerance !== undefined ? { riskTolerance } : {}),
        ...(pauseConditions !== undefined ? { pauseConditions } : {}),
      });
      return toSafeProfileResponse(profile);
    });
  };
}
