# Auth

**Responsibility**: API authentication and authorization. Owns `api_credentials`
(hashed, tenant-scoped, rotatable/revocable) and the Fastify request-decoration
(`fastify.authenticate`) that resolves an authenticated `TenantId` + actor from
the incoming request's `Authorization: Bearer` header.

**Boundary**:
- This is the *only* module allowed to turn a raw credential (API key) into a
  trusted `TenantId`. All other modules receive tenant identity already resolved
  on the request context (`request.ctx.tenantId`) — they never parse headers or
  trust a tenant id supplied in a body/query/param.
- API keys are hashed at rest (HMAC-SHA256 with a server-side pepper — see
  `domain/api-key-hash.ts` for why not a password KDF); the plaintext key is
  shown to the caller exactly once, at creation/rotation time.
- Authentication is opt-in per route (`{ preHandler: fastify.authenticate }`),
  not a global hook — `/health` and `/readiness` stay public by simply not
  opting in, rather than needing an exclusion list.
- Tenant/credential provisioning has no public HTTP endpoint — the bootstrap
  CLI (`src/cli/bootstrap-tenant.ts`) is the only way a tenant gets its first
  credential; everything after that goes through the authenticated
  `/api/v1/credentials` API.

**Target stage**: implemented in Stage 4 (Tenant and API authentication foundation).
