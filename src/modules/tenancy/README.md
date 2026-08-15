# Tenancy

**Responsibility**: owns the `Tenant` aggregate — creation, activation, status, and
tenant-scoped settings. The single source of truth for "does this tenant exist and
is it active."

**Boundary**:
- Every other module that persists tenant-scoped data depends on tenancy only for
  the `TenantId` type and tenant-lookup port — it does not depend on tenancy's
  internal repository implementation.
- Tenant identity for a request is resolved by the `auth` module (from the
  authenticated API key), never accepted from a request body/param here or
  anywhere downstream.

**Target stage**: persistence implemented in Stage 3; the `auth`-resolves-identity
boundary above became real in Stage 4 (Tenant and API authentication foundation).
