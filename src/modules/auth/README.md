# Auth

**Responsibility**: API authentication and authorization. Owns `api_keys`
(hashed, tenant-scoped, rotatable/revocable) and the Fastify request-decoration
that resolves an authenticated `TenantId` + key scopes from the incoming request.

**Boundary**:
- This is the *only* module allowed to turn a raw credential (API key) into a
  trusted `TenantId`. All other modules receive tenant identity already resolved
  on the request context — they never parse headers or trust a tenant id supplied
  in a body/query/param.
- API keys are hashed at rest; the plaintext key is shown to the caller exactly
  once, at creation time.

**Target stage**: Stage 4 (Tenant and API authentication foundation).
