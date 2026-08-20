# Microsoft 365 (managed)

Skout → Microsoft CSP / Graph → Customer tenant → User → Exchange Online.

## Status

| Capability | State |
|---|---|
| Microsoft user OAuth send/inbound (`MICROSOFT_CLIENT_ID` triplet) | Implemented; **CONFIGURED** only when the OAuth triplet is present |
| Graph directory (get/create/suspend/restore/delete user) | Implemented; **NOT_CONFIGURED** until `MICROSOFT_CSP_TENANT_ID` + client id/secret |
| Partner Center customer-tenant creation | **NOT_CONFIGURED** (no fake CSP customers) |
| Production-active managed fleet | **Not claimed** |

Graph user creation is not mailbox-ready for warmup send. Mode B OAuth is
still required before the send adapter will accept mail.

Automated tests mock Graph HTTP. They do not send mail.
