# Provider architecture

`ProviderAdapter` (existing) is the **send / OAuth / health / inbound**
boundary used by warmup execution. It must not be replaced.

`ManagedDirectoryProvider` is a **separate** interface for Google Workspace
reseller / Microsoft directory customer, domain, and mailbox lifecycle.
Unsupported methods stay omitted (`createSubscription` is optional). SMTP/IMAP
does not implement directory APIs.

Normalized failure codes on directory calls:

`NETWORK_ERROR`, `AUTH_ERROR`, `RATE_LIMIT`, `VALIDATION_ERROR`,
`PROVIDER_NOT_READY`, `ALREADY_EXISTS`, `NOT_FOUND`, `PERMISSION_DENIED`,
`TEMPORARY_FAILURE`, `PERMANENT_FAILURE`, `NOT_CONFIGURED`, `UNKNOWN`.

Adding a future provider means:

1. Implement `ProviderAdapter` for send (if the provider can send).
2. Optionally implement `ManagedDirectoryProvider` for provisioning.
3. Register adapters in composition.

Do **not** modify ramp, safety-gate, or execution-worker to know about the
new vendor.

`GET /api/v1/providers` reports adapter `configurationStatus` and directory
`directoryConfigurationStatus`. **CONFIGURED** means credentials are loaded,
not that a live customer fleet exists.
