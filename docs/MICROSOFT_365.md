# Microsoft 365 (managed)

Skout → Microsoft CSP → Customer tenant → Exchange Online → Mailbox.

`createMicrosoft365DirectoryProvider(false)` returns `NOT_CONFIGURED` until
Partner Center / CSP credentials exist. Graph user creation alone is not
treated as mailbox-ready.

Existing Microsoft **user OAuth** (`MICROSOFT_CLIENT_ID` triplet) remains
Mode B. Creating a Graph user is not sufficient for warmup send.
