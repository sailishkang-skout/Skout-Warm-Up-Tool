import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { AuthenticationService } from "../modules/auth/application/authentication-service.js";
import { AuthenticationError } from "../shared/errors/index.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Opt-in, not global: attach as `{ preHandler: fastify.authenticate }`
     * on routes that need it. Deliberately not an `onRequest`/`preHandler`
     * hook applied to every route — that would make "public by default"
     * the accidental failure mode instead of "protected by default", and
     * /health and /readiness must stay reachable with no credential at all.
     */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const BEARER_PREFIX = "Bearer ";

function extractBearerToken(header: string | undefined): string | undefined {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

export function authenticationPlugin(authService: AuthenticationService): FastifyPluginAsync {
  return fp(
    async (fastify) => {
      fastify.decorate("authenticate", async (request: FastifyRequest, _reply: FastifyReply) => {
        // Only `Authorization: Bearer <key>` — never a query parameter or
        // request body, which would otherwise land in access logs, browser
        // history, and proxy logs.
        const token = extractBearerToken(request.headers.authorization);
        if (!token) {
          throw new AuthenticationError("Invalid or missing authentication credentials");
        }

        const identity = await authService.authenticateApiKey(token, {
          requestId: request.ctx.requestId,
          correlationId: request.ctx.correlationId,
          remoteAddress: request.ip,
        });

        request.ctx = {
          ...request.ctx,
          tenantId: identity.tenantId,
          actor: { type: "api_key", credentialId: identity.credentialId, privilege: identity.privilege },
        };
      });
    },
    { name: "authentication" },
  );
}
