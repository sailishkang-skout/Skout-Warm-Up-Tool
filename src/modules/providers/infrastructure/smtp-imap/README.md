# Generic SMTP/IMAP adapter

Implements `MailboxProvider` for any mailbox reachable via standard SMTP
(sending) and IMAP (receiving), for providers without a dedicated API adapter.

**Required external configuration** (documented here as it becomes load-bearing;
not yet wired up in Stage 1):
- SMTP host/port/security mode + credentials
- IMAP host/port/security mode + credentials

Credentials are supplied per-mailbox by the tenant and stored only as encrypted
references via the `shared/` credential-encryption abstraction — never logged,
never persisted in plaintext.
