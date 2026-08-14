# Gmail / Google Workspace adapter

Implements `MailboxProvider` for Gmail and Google Workspace mailboxes via the
Gmail API over OAuth 2.0.

**Required external configuration** (documented here as it becomes load-bearing;
not yet wired up in Stage 1):
- Google OAuth client ID / client secret
- Redirect URI registered with Google
- Requested scopes (send, read, metadata — kept to the minimum needed)

No credentials are ever logged. Access/refresh tokens are stored only as
encrypted references via the `shared/` credential-encryption abstraction.
