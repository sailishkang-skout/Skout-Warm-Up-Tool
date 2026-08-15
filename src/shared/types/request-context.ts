import type { CorrelationId, RequestId, TenantId } from "./ids.js";

/**
 * `actor` is intentionally minimal — real authentication lands in Stage 4.
 * This shape only exists so request-scoped code has somewhere to read
 * tenant/actor identity from once auth populates it.
 */
export interface RequestActor {
  readonly kind: "api-key" | "system";
  readonly id: string;
}

export interface RequestContext {
  readonly requestId: RequestId;
  readonly correlationId: CorrelationId;
  readonly tenantId?: TenantId;
  readonly actor?: RequestActor;
}
