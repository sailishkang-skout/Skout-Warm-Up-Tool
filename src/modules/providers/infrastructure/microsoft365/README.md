# Microsoft 365 adapter

Implements `MailboxProvider` for Microsoft 365 / Outlook mailboxes via the
Microsoft Graph API over OAuth 2.0 (MSAL).

**Required external configuration** (documented here as it becomes load-bearing;
not yet wired up in Stage 1):
- Azure AD application (client) ID / client secret
- Tenant type (single-tenant / multi-tenant) and redirect URI
- Requested Graph scopes (Mail.Send, Mail.Read, etc. — minimum needed)

No credentials are ever logged. Access/refresh tokens are stored only as
encrypted references via the `shared/` credential-encryption abstraction.
