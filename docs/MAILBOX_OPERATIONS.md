# Mailbox operations

Connection status (`PENDING`/`CONNECTING`/`CONNECTED`/...) is unchanged and
still what warmup eligibility uses.

Operational status (`DISCOVERED` → `PROVISIONING` → `PROVISIONED` →
`VERIFYING` → `READY` → `WARMING` → `ACTIVE` → `DEGRADED`/`QUARANTINED`/
`SUSPENDED`/`DELETED`) lives in `mailbox_operational_states` (migration 032).
It is not a second warmup engine.

Roles (`CUSTOMER_SENDER`, `INTERNAL_NETWORK`, `NETWORK_RECIPIENT`) are
explicit; they are not a boolean.

## Connect an existing mailbox (Mode B)

`POST /api/v1/mailboxes` then OAuth connect. This is the production path
when directory APIs are unconfigured.

## Register a customer domain

`POST /api/v1/domains` — status starts `DISCOVERED` / `UNVERIFIED`.

`POST /api/v1/domains/:id/verify` requires explicit DNS evidence
(`mx`/`spf`/`dkim`/`dmarc`). The service never assumes DNS is configured.

`POST /api/v1/provider-accounts` records the tenant↔provider relationship.
It does not create a Google/Microsoft customer.

## Managed provisioning (Mode A)

`POST /api/v1/mailboxes/provision` with `idempotencyKey`.

If directory APIs return `NOT_CONFIGURED` or any failure, **no local mailbox
row is created** and no `MAILBOX_PROVISIONED` audit is written. A job row
records the error. Repeated requests with the same idempotency key replay
that result.

A mailbox row is created only after Google/Microsoft returns a real
provider mailbox id.

## Suspend / recover / quarantine

Use mailbox `enabled`, warmup pause, operational status, and
`POST /api/v1/operations/quarantines`. Network membership pause/quarantine
is owned-partner only.
