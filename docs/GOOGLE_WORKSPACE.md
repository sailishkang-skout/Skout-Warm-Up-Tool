# Google Workspace (managed)

Skout → Google Workspace Reseller → Customer Workspace → Domain → Mailbox.

## Status

| Capability | State |
|---|---|
| Gmail user OAuth send/inbound (`GOOGLE_CLIENT_ID` triplet) | Implemented; **CONFIGURED** only when the OAuth triplet is present |
| Admin SDK + Reseller directory adapter | Implemented; **NOT_CONFIGURED** until `GOOGLE_WORKSPACE_ADMIN_EMAIL` + `GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE` |
| Production-active managed fleet | **Not claimed.** Requires reseller agreement, working domain-wide delegation, and Google-confirmed customer/user ids |

`createGoogleWorkspaceDirectoryProvider` never invents customer or user ids.
If Google returns success without an id, the result is `PROVIDER_NOT_READY`.
If reseller APIs are unset, every mutating call is `NOT_CONFIGURED`.

Automated tests inject `getAccessToken` + `fetchImpl`. They do not send mail.
`ALLOW_LIVE_PROVIDER_TESTS` default `false`.

Existing Gmail **user OAuth** remains the Mode B path. Tokens stay encrypted
in `provider_credentials`. Never returned on APIs.
