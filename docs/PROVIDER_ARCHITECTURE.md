# Provider architecture

`ProviderAdapter` (existing) is the **send / OAuth / health** boundary used by
warmup execution. It must not be replaced.

`ManagedDirectoryProvider` is a **separate** interface for Google Workspace
reseller / Microsoft CSP customer, domain, and mailbox lifecycle.

Adding a future provider means:

1. Implement `ProviderAdapter` for send (if the provider can send).
2. Optionally implement `ManagedDirectoryProvider` for provisioning.
3. Register adapters in composition.

Do **not** modify ramp, safety-gate, or execution-worker to know about the
new vendor.
