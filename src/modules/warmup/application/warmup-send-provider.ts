import type { MailboxId, TenantId } from "../../../shared/types/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ProviderSendResult } from "../domain/send-result.js";

export interface SendWarmupMessageCommand {
  readonly tenantId: TenantId;
  readonly mailboxId: MailboxId;
  readonly provider: MailboxProviderType;
  readonly volume: number;
  readonly idempotencyKey: string;
}

/**
 * The provider-neutral boundary Stage 8 spec section 18 requires. Warmup
 * domain/application code depends on this interface only — it must never
 * import `GmailAdapter`/`Microsoft365Adapter`/`SmtpImapAdapter` directly.
 *
 * No implementation of this in Stage 8 actually sends mail: `ProviderAdapter`
 * (`providers` module, Stage 5) deliberately excludes `sendMessage` — see
 * that file's own doc comment: "adding those speculatively before any
 * conversation engine exists to call them would be exactly the trap
 * section 3 of the Stage 5 spec warns against... they join this interface
 * when Stage 9+ needs them." Stage 8's job is the execution *foundation*
 * (state, decisions, intents, leases, retry) — the one implementation
 * registered in composition (`infrastructure/unimplemented-warmup-send-provider.ts`)
 * honestly reports every call as a safe, non-retryable `PERMANENT_FAILURE`
 * rather than fabricating a send. Real provider execution is Stage 9 work:
 * extend `ProviderAdapter` with `sendMessage`, then add a
 * `WarmupSendProvider` implementation that calls it behind the same
 * `ProviderRegistry` this module never touches directly.
 */
export interface WarmupSendProvider {
  sendWarmupMessage(command: SendWarmupMessageCommand): Promise<ProviderSendResult>;
}
