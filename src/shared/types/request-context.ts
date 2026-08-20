import type { ApiCredentialId, CorrelationId, RequestId, TenantId } from "./ids.js";

/**
 * A discriminated union so future actor kinds (a worker acting on a job, a
 * future end-user session) can be added as new variants without disturbing
 * this one — deliberately not speculatively included now, since nothing
 * produces them yet (see the "no fake auth" note this replaced in Stage 2).
 */
export type RequestActor = {
  readonly type: "api_key";
  readonly credentialId: ApiCredentialId;
  readonly privilege?: "TENANT" | "OPERATOR";
};

export interface RequestContext {
  readonly requestId: RequestId;
  readonly correlationId: CorrelationId;
  readonly tenantId?: TenantId;
  readonly actor?: RequestActor;
}
