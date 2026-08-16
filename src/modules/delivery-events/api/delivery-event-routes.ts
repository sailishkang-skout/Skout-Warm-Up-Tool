import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import { asMailboxId, asWarmupExecutionIntentId, type TenantId } from "../../../shared/types/index.js";
import type { DeliveryEventService } from "../application/delivery-event-service.js";
import { DELIVERY_EVENT_TYPES } from "../domain/delivery-event.js";
import { MAILBOX_PROVIDER_TYPES } from "../../mailbox/domain/mailbox.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

// Deliberately excludes `tenantId` and `source` — tenantId is always
// server-derived from the authenticated request context (Stage 10 spec
// section 19: "never trust tenantId from body"), and `source` is always
// server-set to "INTERNAL_API" for this endpoint (never trusted from the
// caller either) so provenance can never be misrepresented.
const ingestEventSchema = z.object({
  mailboxId: z.string().regex(UUID_PATTERN, "Invalid mailbox id"),
  executionIntentId: z.string().regex(UUID_PATTERN, "Invalid execution intent id").optional(),
  provider: z.enum(MAILBOX_PROVIDER_TYPES),
  providerEventId: z.string().min(1).max(512).optional(),
  eventType: z.enum(DELIVERY_EVENT_TYPES),
  observedAt: z.iso.datetime(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Registered under /api/v1/internal — authenticated the same way every
 * other route in this service is (there is no separate provider-webhook
 * authentication yet). Stage 10 spec section 5/19: a real Gmail/Microsoft
 * webhook endpoint (signature verification, provider-specific payload
 * parsing) is later work — this is deliberately the safe fallback the spec
 * allows ("build the normalized ingestion boundary and mocked adapter
 * tests instead... DO NOT create an insecure accept-any-webhook endpoint").
 * A future webhook handler would normalize a provider payload into exactly
 * this same shape and call the same `DeliveryEventService`.
 */
export function deliveryEventRoutes(deliveryEventService: DeliveryEventService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.post("/delivery-events", { preHandler: fastify.authenticate }, async (request, reply) => {
      const tenantId = requireTenantId(request);
      const parsed = ingestEventSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid delivery event", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
      }
      const body = parsed.data;

      const { event, wasNew } = await deliveryEventService.ingestDeliveryEvent({
        tenantId,
        mailboxId: asMailboxId(body.mailboxId),
        provider: body.provider,
        eventType: body.eventType,
        observedAt: new Date(body.observedAt),
        source: "INTERNAL_API",
        ...(body.executionIntentId ? { executionIntentId: asWarmupExecutionIntentId(body.executionIntentId) } : {}),
        ...(body.providerEventId ? { providerEventId: body.providerEventId } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      });

      reply.status(wasNew ? 201 : 200);
      return { id: event.id, mailboxId: event.mailboxId, eventType: event.eventType, wasNew };
    });
  };
}
