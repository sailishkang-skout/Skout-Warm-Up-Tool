import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthorizationError, ValidationError } from "../../../shared/errors/index.js";
import { asMailboxId, type MailboxId, type TenantId } from "../../../shared/types/index.js";
import type { ProviderCapabilities } from "../../providers/domain/provider-capabilities.js";
import type { MailboxService } from "../application/mailbox-service.js";
import { MAILBOX_PROVIDER_TYPES } from "../domain/mailbox.js";
import type { Mailbox } from "../domain/mailbox.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createMailboxBodySchema = z.object({
  emailAddress: z.string().trim().min(3).max(320),
  provider: z.enum(MAILBOX_PROVIDER_TYPES),
  displayName: z.string().trim().min(1).max(200).optional(),
});

/**
 * `request.ctx.tenantId` is only ever populated by the Stage 4 authentication
 * plugin from a verified credential — never from the request body, params,
 * or query. Any `tenantId` field present in a request body is simply not
 * part of this schema, so zod strips it silently rather than this module
 * needing to remember to reject it.
 */
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

function toSafeMailboxResponse(mailbox: Mailbox) {
  return {
    id: mailbox.id,
    emailAddress: mailbox.emailAddress,
    provider: mailbox.provider,
    status: mailbox.status,
    enabled: mailbox.enabled,
    displayName: mailbox.displayName,
    createdAt: mailbox.createdAt.toISOString(),
    updatedAt: mailbox.updatedAt.toISOString(),
  };
}

function toSafeCapabilitiesResponse(mailbox: Mailbox, capabilities: ProviderCapabilities) {
  return { mailboxId: mailbox.id, provider: mailbox.provider, capabilities };
}

/** Registered under /api/v1/mailboxes. Every route requires authentication. */
export function mailboxRoutes(mailboxService: MailboxService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.post("/", { preHandler: fastify.authenticate }, async (request, reply) => {
      const tenantId = requireTenantId(request);
      const parsed = createMailboxBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid mailbox creation payload", {
          fieldErrors: z.flattenError(parsed.error).fieldErrors,
        });
      }

      const mailbox = await mailboxService.createMailbox(tenantId, {
        emailAddress: parsed.data.emailAddress,
        provider: parsed.data.provider,
        ...(parsed.data.displayName ? { displayName: parsed.data.displayName } : {}),
      });

      reply.status(201);
      return toSafeMailboxResponse(mailbox);
    });

    fastify.get("/", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const mailboxes = await mailboxService.listMailboxes(tenantId);
      return { mailboxes: mailboxes.map(toSafeMailboxResponse) };
    });

    fastify.get<{ Params: { id: string } }>("/:id", { preHandler: fastify.authenticate }, async (request) => {
      const tenantId = requireTenantId(request);
      const mailbox = await mailboxService.getMailbox(tenantId, parseMailboxId(request.params.id));
      return toSafeMailboxResponse(mailbox);
    });

    fastify.post<{ Params: { id: string } }>(
      "/:id/connect",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailbox = await mailboxService.connectMailbox(tenantId, parseMailboxId(request.params.id));
        return toSafeMailboxResponse(mailbox);
      },
    );

    fastify.post<{ Params: { id: string } }>(
      "/:id/disconnect",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailbox = await mailboxService.disconnectMailbox(tenantId, parseMailboxId(request.params.id));
        return toSafeMailboxResponse(mailbox);
      },
    );

    fastify.post<{ Params: { id: string } }>(
      "/:id/enable",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailbox = await mailboxService.enableMailbox(tenantId, parseMailboxId(request.params.id));
        return toSafeMailboxResponse(mailbox);
      },
    );

    fastify.post<{ Params: { id: string } }>(
      "/:id/disable",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailbox = await mailboxService.disableMailbox(tenantId, parseMailboxId(request.params.id));
        return toSafeMailboxResponse(mailbox);
      },
    );

    fastify.get<{ Params: { id: string } }>(
      "/:id/capabilities",
      { preHandler: fastify.authenticate },
      async (request) => {
        const tenantId = requireTenantId(request);
        const mailboxId = parseMailboxId(request.params.id);
        const [mailbox, capabilities] = await Promise.all([
          mailboxService.getMailbox(tenantId, mailboxId),
          mailboxService.getCapabilities(tenantId, mailboxId),
        ]);
        return toSafeCapabilitiesResponse(mailbox, capabilities);
      },
    );
  };
}
