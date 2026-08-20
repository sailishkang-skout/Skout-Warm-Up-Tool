# Google Workspace (managed)

Skout → Google Workspace Reseller → Customer Workspace → Domain → Mailbox.

This repo’s `createGoogleWorkspaceDirectoryProvider(false)` returns
`NOT_CONFIGURED` for create/verify/suspend until reseller credentials exist.

Existing Gmail **user OAuth** (`GOOGLE_CLIENT_ID` triplet) remains the Mode B
path: connect a mailbox the customer already owns. Tokens stay encrypted in
`provider_credentials`. Never returned on APIs.
