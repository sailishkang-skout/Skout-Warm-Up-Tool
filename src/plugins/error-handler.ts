import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { AppError, InternalError, NotFoundError, ValidationError } from "../shared/errors/index.js";
import { sanitizeForLogging } from "../shared/logger/index.js";

function isFastifyValidationError(error: unknown): error is Error & { validation: unknown[] } {
  return (
    error instanceof Error &&
    "validation" in error &&
    Array.isArray((error as { validation?: unknown }).validation)
  );
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }
  if (isFastifyValidationError(error)) {
    return new ValidationError(error.message);
  }
  return new InternalError("An unexpected error occurred", { cause: error });
}

/**
 * Single place every thrown error and unmatched route funnels through.
 * Guarantees the API never returns a stack trace or internal error detail —
 * only `AppError.toPublicJSON()`'s deliberately-safe shape ever reaches the
 * client, while the full error (including `details`) is logged internally.
 */
export const errorHandlerPlugin: FastifyPluginAsync = fp(
  async (fastify) => {
    fastify.setNotFoundHandler((request, reply) => {
      const error = new NotFoundError("Route", request.url);
      reply.status(error.httpStatus).send(error.toPublicJSON(request.ctx?.requestId));
    });

    fastify.setErrorHandler((rawError, request, reply) => {
      const error = toAppError(rawError);
      const requestId = request.ctx?.requestId;
      const logPayload = { err: error, details: sanitizeForLogging(error.details) };

      if (error.httpStatus >= 500) {
        request.log.error(logPayload, error.message);
      } else {
        request.log.warn(logPayload, error.message);
      }

      reply.status(error.httpStatus).send(error.toPublicJSON(requestId));
    });
  },
  { name: "error-handler" },
);
