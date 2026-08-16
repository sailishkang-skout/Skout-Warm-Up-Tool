# Provider send certification — manual runbook

This is the **only** procedure in this repository that sends a real email
through a real Gmail/Microsoft 365 connection outside a test's mocked
`fetch`. It exists to manually validate a provider integration end-to-end
— OAuth credential resolution, the real HTTP call, and the provider's real
response — before enabling that provider for real warmup traffic.

It is deliberately **not automated**: not run by `npm test`, not run by
`npm run test:db`, not run in CI, and not reachable from the HTTP server or
the execution worker. The only entry point is a human running
`npm run certify:provider-send` with environment variables set for that one
invocation.

## Before you run this

- You need a mailbox already connected via the normal OAuth flow (`/api/v1/oauth/...`)
  for the tenant/mailbox you're certifying — this script does not perform
  OAuth itself, it only resolves and refreshes an already-stored credential
  (`providers/application/resolve-fresh-credential.ts`, the same function
  every other send path uses).
- Pick a **controlled recipient address you own and can check** — this
  script sends one real, clearly-labeled certification email to it. Never
  point this at a real user's mailbox or a distribution list.
- This is a live send. It counts against the connected account's real
  provider rate limits and will appear in its real Sent folder.

## Required environment

Set these for the single invocation only — do not add them to a
long-lived `.env` file used by the server or by tests:

| Variable | Purpose |
| --- | --- |
| `ALLOW_LIVE_PROVIDER_CERTIFICATION` | Must be exactly `true`. The script refuses to run — before opening any database connection — if this is missing or any other value. |
| `CERTIFICATION_TENANT_ID` | The tenant UUID that owns the mailbox being certified. |
| `CERTIFICATION_MAILBOX_ID` | The mailbox UUID to send from. Must already have a connected provider account. |
| `CERTIFICATION_RECIPIENT_EMAIL` | The controlled recipient address (see above). No default — the script has no hardcoded recipient anywhere. |

Everything else (`DATABASE_URL`, `ENCRYPTION_KEY`, `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI`, `MICROSOFT_CLIENT_ID` /
`MICROSOFT_CLIENT_SECRET` / `MICROSOFT_REDIRECT_URI`) is the same
configuration the server already runs with — see
`src/shared/config/schema.ts`. No certification-specific credentials exist;
this script reuses the deployment's real, already-configured provider
OAuth apps and the real, already-encrypted credential store.

## Running it

```bash
ALLOW_LIVE_PROVIDER_CERTIFICATION=true \
CERTIFICATION_TENANT_ID=<tenant-uuid> \
CERTIFICATION_MAILBOX_ID=<mailbox-uuid> \
CERTIFICATION_RECIPIENT_EMAIL=<you@your-controlled-domain.example> \
npm run certify:provider-send
```

The script prints the mailbox/recipient it's about to use, sends one
message via the real `ProviderAdapter.sendMessage` (the exact same code
path `AdapterWarmupSendProvider` uses in production — see
`src/modules/warmup/infrastructure/adapter-warmup-send-provider.ts`), and
prints the provider's normalized outcome (`ACCEPTED` /`AUTH_FAILED`/
`RATE_LIMITED`/`TEMPORARY_FAILURE`/`PERMANENT_FAILURE`/`SEND_UNKNOWN` — see
`src/modules/providers/domain/send-message.ts`). It never prints an access
token, refresh token, or raw provider response body.

Exit code is `0` only on `ACCEPTED`; any other outcome exits non-zero.

## After it runs

1. **Check the exit code and printed status first.** `ACCEPTED` with a
   `messageId` (Gmail) or `ACCEPTED` with no id (Microsoft Graph never
   returns one — see `warmup/README.md`'s idempotency section) means the
   provider claims to have accepted the send.
2. **Verify Skout's own state**: confirm no `warmup_execution_intents` row
   was created for this send (this script never creates one — it bypasses
   the whole execution-intent pipeline on purpose, since it isn't a warmup
   send) and confirm this run does not appear anywhere in warmup
   session/decision history for the mailbox.
3. **Verify the provider side**: check the controlled recipient's inbox
   and, if possible, the sending mailbox's own Sent folder, to confirm the
   provider's `ACCEPTED` response actually corresponds to a delivered
   message. This is manual — there is no automated verification step,
   because there is no automated way to check a third-party mailbox from
   this service.
4. Only after both checks pass should this provider/credential combination
   be considered certified for real warmup traffic. A `SEND_UNKNOWN`
   result specifically means step 3 could not be automated even in
   principle for this attempt — see the idempotency limitation in
   `docs/ARCHITECTURE.md` before assuming anything about whether it sent.

## What this deliberately does not do

- Does not create fake "successful" sends — every result is the adapter's
  own honest, normalized outcome, including a real `AUTH_FAILED` or
  `SEND_UNKNOWN` if that's genuinely what happened.
- Does not add a second OAuth flow, a second credential store, or a second
  send implementation — it is a thin, explicitly-gated caller of the exact
  code that already runs in production.
- Does not run, or get invoked by anything that runs, in CI. If you find
  this script referenced from a CI workflow, that is a bug — remove the
  reference rather than adding a bypass for it.
