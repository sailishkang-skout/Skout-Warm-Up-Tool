import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "../types/index.js";

/**
 * Backs request-scoped context propagation for both HTTP requests (see
 * `src/plugins/request-context.ts`) and, later, worker/job execution — one
 * mechanism, so a service function doesn't need to know whether it's running
 * inside a request or a BullMQ job to find its correlation id.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function requireRequestContext(): RequestContext {
  const context = requestContextStorage.getStore();
  if (!context) {
    throw new Error("No request context is active on the current async execution path");
  }
  return context;
}

/**
 * Preferred entry point for anything with a single well-defined lifetime it
 * controls end-to-end (a worker/job handler, a script, a test) — the context
 * is scoped exactly to `fn` and cannot leak past it.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}
