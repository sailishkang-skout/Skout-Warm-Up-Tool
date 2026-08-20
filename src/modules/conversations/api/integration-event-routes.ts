import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import { asConversationId, asIntegrationEventId, type TenantId } from "../../../shared/types/index.js";
import {
  INTEGRATION_CONTRACT_VERSION,
  INTEGRATION_EVENTS_DEFAULT_PAGE_SIZE,
  INTEGRATION_EVENTS_MAX_PAGE_SIZE,
  sliceIntegrationEventPage,
  toIntegrationEventListResponse,
} from "../application/integration-event-consumption.js";
import type { IntegrationEventRepository } from "../application/integration-event-repository.js";
import { isIntegrationEventType } from "../domain/integration-event-taxonomy.js";
import { incrementCounter, METRIC } from "../../../shared/observability/index.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(request: FastifyRequest): TenantId {
  const tenantId = request.ctx.tenantId;
  if (!tenantId) {
    throw new AuthorizationError("Authenticated tenant context is required");
  }
  return tenantId;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(INTEGRATION_EVENTS_MAX_PAGE_SIZE).default(INTEGRATION_EVENTS_DEFAULT_PAGE_SIZE),
  eventType: z.string().min(1).optional(),
  cursor: z.string().regex(UUID_PATTERN, "Invalid cursor").optional(),
  conversationId: z.string().regex(UUID_PATTERN, "Invalid conversation id").optional(),
});

/**
 * Authenticated pull of durable integration events. No ACK endpoint: events
 * remain in the outbox, payloads are immutable, and `eventId` is stable, so
 * a continuation token is sufficient. Consumers dedupe on `eventId`.
 */
export function integrationEventRoutes(repository: IntegrationEventRepository): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get("/", { preHandler: fastify.authenticate }, async (request, reply) => {
      const tenantId = requireTenantId(request);
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        throw new ValidationError("Invalid integration event list query", {
          fieldErrors: z.flattenError(parsed.error).fieldErrors,
        });
      }
      const eventType = parsed.data.eventType;
      if (eventType !== undefined && !isIntegrationEventType(eventType)) {
        throw new ValidationError("Invalid integration event type filter");
      }
      const afterEventId = parsed.data.cursor ? asIntegrationEventId(parsed.data.cursor) : undefined;
      if (afterEventId) {
        const cursorEvent = await repository.getByEventId(tenantId, afterEventId);
        if (!cursorEvent) {
          throw new ValidationError("Invalid cursor");
        }
      }
      const rows = await repository.list({
        tenantId,
        limit: parsed.data.limit + 1,
        ...(eventType !== undefined && isIntegrationEventType(eventType) ? { eventType } : {}),
        ...(afterEventId ? { afterEventId } : {}),
        ...(parsed.data.conversationId ? { conversationId: asConversationId(parsed.data.conversationId) } : {}),
      });
      const page = sliceIntegrationEventPage(rows, parsed.data.limit);
      incrementCounter(METRIC.integrationEventsRead, page.events.length);
      reply.header("X-Integration-Contract-Version", INTEGRATION_CONTRACT_VERSION);
      return toIntegrationEventListResponse(page);
    });
  };
}
