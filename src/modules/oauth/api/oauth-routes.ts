import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { OAuthCapableProviderType, OAuthConnectionService } from "../application/oauth-connection-service.js";

const OAUTH_PROVIDER_SEGMENTS = { google: "GMAIL", microsoft: "MICROSOFT365" } as const satisfies Record<
  string,
  OAuthCapableProviderType
>;

const callbackQuerySchema = z.object({
  state: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Public — deliberately NOT registered with `fastify.authenticate` — because
 * the browser/provider redirect that lands here never carries a Skout API
 * key (Stage 6 spec section 13). What binds this callback back to the
 * authenticated request that started the flow is the OAuth state itself,
 * validated inside `OAuthConnectionService.handleCallback` (single-use,
 * short-lived, tenant/mailbox/provider-bound) — not anything on this
 * request. Every failure this route can produce is already a safe,
 * curated `AppError` by the time it reaches here; nothing here decides
 * what's safe to reveal.
 */
export function oauthRoutes(oauthConnectionService: OAuthConnectionService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    for (const [segment, providerType] of Object.entries(OAUTH_PROVIDER_SEGMENTS)) {
      fastify.get(`/${segment}/callback`, async (request) => {
        const parsed = callbackQuerySchema.safeParse(request.query);
        const params = parsed.success ? parsed.data : {};

        const result = await oauthConnectionService.handleCallback(providerType, params, {
          requestId: request.ctx.requestId,
          correlationId: request.ctx.correlationId,
        });

        return { status: "connected", mailboxId: result.mailboxId, provider: result.provider };
      });
    }
  };
}
