import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import { resolveFreshCredential } from "../../providers/application/resolve-fresh-credential.js";
import type { ProviderAccountRepository } from "../../providers/application/provider-account-repository.js";
import type { ProviderCredentialStore } from "../../providers/application/provider-credential-store.js";
import type { ProviderRegistry } from "../../providers/application/provider-registry.js";
import type { ProviderSendOutcome, ProviderSendOutcomeStatus } from "../../providers/domain/send-message.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import { generateWarmupMessage } from "../domain/warmup-message.js";
import type { ProviderSendResult, ProviderSendStatus } from "../domain/send-result.js";
import type { SendWarmupMessageCommand, WarmupSendProvider } from "../application/warmup-send-provider.js";

export interface CreateAdapterWarmupSendProviderDeps {
  readonly mailboxService: MailboxService;
  readonly providerAccountRepository: ProviderAccountRepository;
  readonly credentialStore: ProviderCredentialStore;
  readonly providerRegistry: ProviderRegistry;
  readonly auditRecorder: AuditEventRecorder;
}

// The provider-layer outcome vocabulary and warmup's own are identical in
// content today (see send-message.ts's doc comment for why they're
// deliberately separate types anyway) — this is the one place that maps
// between them, so a future divergence only ever needs to change here.
const STATUS_MAP: Readonly<Record<ProviderSendOutcomeStatus, ProviderSendStatus>> = {
  ACCEPTED: "ACCEPTED",
  AUTH_FAILED: "AUTH_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  TEMPORARY_FAILURE: "TEMPORARY_FAILURE",
  PERMANENT_FAILURE: "PERMANENT_FAILURE",
  SEND_UNKNOWN: "SEND_UNKNOWN",
};

function toResult(provider: MailboxProviderType, outcome: ProviderSendOutcome): ProviderSendResult {
  return {
    status: STATUS_MAP[outcome.status],
    provider,
    timestamp: new Date(),
    retryable: outcome.retryable,
    ...(outcome.providerMessageId ? { providerMessageId: outcome.providerMessageId } : {}),
    ...(outcome.safeReason ? { safeReason: outcome.safeReason } : {}),
  };
}

function unavailable(provider: MailboxProviderType, safeReason: string): ProviderSendResult {
  return { status: "PERMANENT_FAILURE", provider, timestamp: new Date(), retryable: false, safeReason };
}

/**
 * The one, provider-agnostic `WarmupSendProvider` implementation Stage 9
 * adds — deliberately not `GmailWarmupSendProvider`/
 * `MicrosoftWarmupSendProvider` (Stage 9 spec section 3 forbids exactly
 * that duplication). Resolves the right `ProviderAdapter` through the same
 * `ProviderRegistry` every other module uses, and the same
 * `resolveFreshCredential` `mailbox`'s own OAuth connect/health paths use
 * — no second credential-refresh implementation, no second OAuth system.
 *
 * Warmup domain/application code never sees any of this: it only ever
 * calls `WarmupSendProvider.sendWarmupMessage` and gets back a normalized
 * `ProviderSendResult` (Stage 9 spec section 2's boundary).
 */
export function createAdapterWarmupSendProvider(deps: CreateAdapterWarmupSendProviderDeps): WarmupSendProvider {
  const { mailboxService, providerAccountRepository, credentialStore, providerRegistry, auditRecorder } = deps;

  return {
    async sendWarmupMessage(command: SendWarmupMessageCommand): Promise<ProviderSendResult> {
      const adapter = providerRegistry.resolve(command.provider);
      if (!adapter.sendMessage) {
        return unavailable(command.provider, `${command.provider} does not support sending in this deployment yet.`);
      }

      const mailbox = await mailboxService.getMailbox(command.tenantId, command.mailboxId);
      const providerAccount = await providerAccountRepository.findByMailboxId(command.tenantId, command.mailboxId);
      if (!providerAccount) {
        return { status: "AUTH_FAILED", provider: command.provider, timestamp: new Date(), retryable: false, safeReason: "No provider account is connected for this mailbox." };
      }

      const credential = await resolveFreshCredential(command.tenantId, providerAccount.id, adapter, credentialStore, auditRecorder);
      if (!credential) {
        return { status: "AUTH_FAILED", provider: command.provider, timestamp: new Date(), retryable: false, safeReason: "No usable credential is stored for this mailbox." };
      }

      const message = generateWarmupMessage({ fromAddress: mailbox.emailAddressCanonical, idempotencyKey: command.idempotencyKey });
      const outcome = await adapter.sendMessage(credential, {
        from: mailbox.emailAddressCanonical,
        to: message.to,
        subject: message.subject,
        body: message.body,
      });
      return toResult(command.provider, outcome);
    },
  };
}
