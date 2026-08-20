import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import { resolveFreshCredential } from "../../providers/application/resolve-fresh-credential.js";
import type { ProviderAccountRepository } from "../../providers/application/provider-account-repository.js";
import type { ProviderCredentialStore } from "../../providers/application/provider-credential-store.js";
import type { ProviderRegistry } from "../../providers/application/provider-registry.js";
import type { ProviderSendOutcome, ProviderSendOutcomeStatus } from "../../providers/domain/send-message.js";
import { ProviderError } from "../../../shared/errors/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { WarmupNetworkMailboxId } from "../../../shared/types/index.js";
import type { WarmupNetworkRouter } from "../../warmup-network/application/warmup-network-router.js";
import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import { generateWarmupMessage } from "../domain/warmup-message.js";
import type { ProviderSendResult, ProviderSendStatus } from "../domain/send-result.js";
import type { SendWarmupMessageCommand, WarmupSendProvider } from "../application/warmup-send-provider.js";

export type WarmupNetworkRoutingMode = "off" | "prefer" | "require" | "internal" | "partner" | "hybrid";

export interface CreateAdapterWarmupSendProviderDeps {
  readonly mailboxService: MailboxService;
  readonly providerAccountRepository: ProviderAccountRepository;
  readonly credentialStore: ProviderCredentialStore;
  readonly providerRegistry: ProviderRegistry;
  readonly auditRecorder: AuditEventRecorder;
  readonly warmupNetworkRouter?: WarmupNetworkRouter;
  readonly warmupNetworkRoutingMode?: WarmupNetworkRoutingMode;
  readonly isExecutionPaused?: () => Promise<boolean>;
  readonly isSendBlocked?: (context: {
    readonly tenantId: string;
    readonly mailboxId: string;
    readonly provider: string;
  }) => Promise<boolean>;
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
 *
 * Stage 20 may optionally route `to` through the managed warmup network
 * when `warmupNetworkRoutingMode` is `prefer` or `require`. Default `off`
 * never queries the network and keeps self-send.
 */
function routingFailure(
  provider: MailboxProviderType,
  failureClass: "TEMPORARY" | "PERMANENT",
  safeReason: string,
): ProviderSendResult {
  if (failureClass === "TEMPORARY") {
    return { status: "TEMPORARY_FAILURE", provider, timestamp: new Date(), retryable: true, safeReason };
  }
  return { status: "PERMANENT_FAILURE", provider, timestamp: new Date(), retryable: false, safeReason };
}

export function createAdapterWarmupSendProvider(deps: CreateAdapterWarmupSendProviderDeps): WarmupSendProvider {
  const {
    mailboxService,
    providerAccountRepository,
    credentialStore,
    providerRegistry,
    auditRecorder,
    warmupNetworkRouter,
    warmupNetworkRoutingMode = "off",
    isExecutionPaused,
    isSendBlocked,
  } = deps;

  return {
    async sendWarmupMessage(command: SendWarmupMessageCommand): Promise<ProviderSendResult> {
      if (
        (isSendBlocked &&
          (await isSendBlocked({
            tenantId: command.tenantId,
            mailboxId: command.mailboxId,
            provider: command.provider,
          }))) ||
        (isExecutionPaused && (await isExecutionPaused()))
      ) {
        return {
          status: "TEMPORARY_FAILURE",
          provider: command.provider,
          timestamp: new Date(),
          retryable: true,
          safeReason: "Execution is paused by an operational kill switch.",
        };
      }
      const adapter = providerRegistry.resolve(command.provider);
      if (!adapter.sendMessage) {
        return unavailable(command.provider, `${command.provider} does not support sending in this deployment yet.`);
      }

      const mailbox = await mailboxService.getMailbox(command.tenantId, command.mailboxId);
      const providerAccount = await providerAccountRepository.findByMailboxId(command.tenantId, command.mailboxId);
      if (!providerAccount) {
        return { status: "AUTH_FAILED", provider: command.provider, timestamp: new Date(), retryable: false, safeReason: "No provider account is connected for this mailbox." };
      }

      let credential;
      try {
        credential = await resolveFreshCredential(command.tenantId, providerAccount.id, adapter, credentialStore, auditRecorder);
      } catch (error) {
        // Stage 12.1: `resolveFreshCredential` only ever throws for a
        // bounded, retryable refresh failure (a timeout or transient
        // network error) — a genuinely dead refresh token never throws,
        // it resolves to `undefined` (handled below). Classified as
        // `TEMPORARY_FAILURE`, not `AUTH_FAILED`: the credential itself
        // was never confirmed invalid, so `domain/retry-policy.ts` should
        // retry rather than terminally fail the intent. Anything other
        // than the one classified case is deliberately rethrown, not
        // swallowed — `WarmupSendProvider.sendWarmupMessage` is documented
        // to never throw, so an unexpected exception here means a real
        // bug that should surface loudly, not a fabricated result.
        if (error instanceof ProviderError && error.retryable) {
          const isTimeout = error.details?.reason === "timeout";
          return {
            status: "TEMPORARY_FAILURE",
            provider: command.provider,
            timestamp: new Date(),
            retryable: true,
            safeReason: isTimeout
              ? `Timed out refreshing the ${command.provider} credential before sending.`
              : `Could not reach ${command.provider} to refresh the credential before sending.`,
          };
        }
        throw error;
      }
      if (!credential) {
        return { status: "AUTH_FAILED", provider: command.provider, timestamp: new Date(), retryable: false, safeReason: "No usable credential is stored for this mailbox." };
      }

      let toAddress: string | undefined;
      let routedMailboxId: WarmupNetworkMailboxId | undefined;

      if (warmupNetworkRoutingMode !== "off" && warmupNetworkRouter) {
        let routed;
        try {
          routed = await warmupNetworkRouter.selectWarmupMailbox({
            customerTenantId: command.tenantId,
            customerMailboxId: command.mailboxId,
            requestKey: command.idempotencyKey,
            now: new Date(),
          });
        } catch {
          return routingFailure(
            command.provider,
            "TEMPORARY",
            "Warmup-network routing could not be completed because of a temporary infrastructure failure.",
          );
        }
        if (routed.selected) {
          toAddress = routed.selected.mailboxAddress;
          routedMailboxId = routed.selected.networkMailboxId;
        } else if (warmupNetworkRoutingMode !== "prefer") {
          const failureClass = routed.failureClass ?? "PERMANENT";
          return routingFailure(
            command.provider,
            failureClass,
            failureClass === "TEMPORARY"
              ? "No eligible warmup-network mailbox is currently available (capacity or cooldown)."
              : "No eligible warmup-network mailbox could be selected.",
          );
        }
      }

      const message = generateWarmupMessage({
        fromAddress: mailbox.emailAddressCanonical,
        ...(toAddress ? { toAddress } : {}),
        idempotencyKey: command.idempotencyKey,
      });
      const outcome = await adapter.sendMessage(credential, {
        from: mailbox.emailAddressCanonical,
        to: message.to,
        subject: message.subject,
        body: message.body,
      });
      const result = toResult(command.provider, outcome);
      if (warmupNetworkRouter && routedMailboxId) {
        if (result.status === "ACCEPTED") {
          await warmupNetworkRouter.recordSendAccepted(routedMailboxId, result.timestamp);
        } else if (result.status === "AUTH_FAILED") {
          incrementCounter(METRIC.warmupNetworkRouteAuthFailed);
        }
      }
      return result;
    },
  };
}
