import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { requestContextStorage } from "../shared/observability/index.js";
import { asCorrelationId, asRequestId } from "../shared/types/index.js";
import type { RequestContext } from "../shared/types/index.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Always populated by the time any route handler or downstream hook
     * runs — the `onRequest` hook below is the first thing to touch every
     * request. Decorated with `undefined` below only to satisfy Fastify's
     * decoration API; treat it as always-present in application code.
     */
    ctx: RequestContext;
  }
}

const CORRELATION_ID_HEADER = "x-correlation-id";

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Assigns request/correlation identity and makes it available two ways:
 * `request.ctx` for Fastify-aware code, and AsyncLocalStorage (via
 * `enterWith`) for everything else. `enterWith` — rather than `run()` — is
 * used deliberately: Fastify drives the rest of the request lifecycle itself
 * across separate hook invocations, so there is no single callback we could
 * wrap with `run()`. `enterWith` attaches the store to the current async
 * execution context instead, and it propagates through every `await` Fastify
 * performs for the remainder of this request's continuation.
 */
export const requestContextPlugin: FastifyPluginAsync = fp(
  async (fastify) => {
    fastify.decorateRequest("ctx", undefined, []);

    fastify.addHook("onRequest", async (request, reply) => {
      const requestId = asRequestId(request.id);
      const incomingCorrelationId = firstHeaderValue(request.headers[CORRELATION_ID_HEADER]);
      const correlationId = asCorrelationId(
        incomingCorrelationId && incomingCorrelationId.length > 0
          ? incomingCorrelationId
          : request.id,
      );

      const context: RequestContext = { requestId, correlationId };

      request.ctx = context;
      reply.header("x-request-id", requestId);
      reply.header(CORRELATION_ID_HEADER, correlationId);

      requestContextStorage.enterWith(context);
    });
  },
  { name: "request-context" },
);
