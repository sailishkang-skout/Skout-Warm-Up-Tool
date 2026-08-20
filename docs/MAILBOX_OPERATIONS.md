# Mailbox operations

## Connect an existing mailbox (Mode B)

`POST /api/v1/mailboxes` then OAuth connect. This is the production path today.

## Register a customer domain

`POST /api/v1/domains` — status starts `DISCOVERED` / `UNVERIFIED`.

`POST /api/v1/domains/:id/verify` requires explicit DNS evidence
(`mx`/`spf`/`dkim`/`dmarc`). The service never assumes DNS is configured.

## Managed provisioning (Mode A)

`POST /api/v1/mailboxes/provision` with `idempotencyKey`.

Creates a local mailbox + provisioning job. Google/Microsoft directory
adapters currently return `NOT_CONFIGURED` unless reseller/CSP credentials
are supplied (they are not in this deployment). The local mailbox still
exists so Mode B OAuth can complete the connection.

## Suspend / recover

Use existing mailbox `enabled` flag and warmup pause. Network membership
pause/quarantine is `POST /api/v1/warmup-network/mailboxes/:id/pause` for
**owned** partner members only.
