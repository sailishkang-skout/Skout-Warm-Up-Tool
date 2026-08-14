# Providers

**Responsibility**: the `MailboxProvider` adapter interface (`domain/`) and its
concrete implementations (`infrastructure/gmail`, `infrastructure/microsoft365`,
`infrastructure/smtp-imap`). Provider-specific behavior — auth flow, rate limits,
capability differences — lives entirely inside the relevant adapter and is never
duplicated into business-logic modules.

**Boundary**:
- `mailbox`, `warmup`, and `conversations` depend only on the `MailboxProvider`
  interface exported from `domain/`, never on a specific adapter. Selecting the
  right adapter for a given mailbox is this module's `application/` layer's job
  (a small provider registry/factory), not a switch statement scattered across
  callers.
- Each adapter subfolder documents the external configuration (OAuth client
  credentials, SMTP/IMAP host settings, etc.) it requires to function — none of
  that configuration is faked or stubbed into "success" when absent; an adapter
  that can't be configured fails closed with a typed configuration error.

**Target stage**: Stage 5 (interface + adapter skeletons), adapters completed
alongside the modules that first need them.
