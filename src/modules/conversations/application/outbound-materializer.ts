import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { ProviderAccountRepository } from "../../providers/application/provider-account-repository.js";
import type { ProviderCredentialStore } from "../../providers/application/provider-credential-store.js";
import type { ProviderRegistry } from "../../providers/application/provider-registry.js";
import { resolveFreshCredential } from "../../providers/application/resolve-fresh-credential.js";
import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import {
  matchGraphSentItem,
  Microsoft365InboundProvider,
} from "../../providers/infrastructure/microsoft365/microsoft365-inbound-provider.js";
import type { Logger } from "../../../shared/logger/index.js";
import type { ConversationMessageRepository } from "./conversation-message-repository.js";
import type { ConversationService } from "./conversation-service.js";
import type { InboundMessageProvider } from "./inbound-message-provider.js";
import type { UnmaterializedSentIntent } from "../infrastructure/unmaterialized-sent-intent-reader.js";

export interface OutboundMaterializerTickResult {
  readonly considered: number;
  readonly materialized: number;
  readonly linked: number;
  readonly unmatched: number;
}

export interface OutboundMaterializer {
  runTick(): Promise<OutboundMaterializerTickResult>;
}

export interface CreateOutboundMaterializerDeps {
  readonly mailboxService: MailboxService;
  readonly providerRegistry: ProviderRegistry;
  readonly providerAccountRepository: ProviderAccountRepository;
  readonly credentialStore: ProviderCredentialStore;
  readonly auditRecorder: AuditEventRecorder;
  readonly conversationService: ConversationService;
  readonly messageRepository: ConversationMessageRepository;
  readonly inboundProviders: Readonly<Record<"GMAIL" | "MICROSOFT365", InboundMessageProvider>>;
  readonly graphInboundProvider: Microsoft365InboundProvider;
  readonly listUnmaterialized: (limit: number) => Promise<readonly UnmaterializedSentIntent[]>;
  readonly logger: Logger;
}

const BATCH = 25;

export function createOutboundMaterializer(deps: CreateOutboundMaterializerDeps): OutboundMaterializer {
  const {
    mailboxService,
    providerRegistry,
    providerAccountRepository,
    credentialStore,
    auditRecorder,
    conversationService,
    messageRepository,
    inboundProviders,
    graphInboundProvider,
    listUnmaterialized,
    logger,
  } = deps;

  return {
    async runTick(): Promise<OutboundMaterializerTickResult> {
      const intents = await listUnmaterialized(BATCH);
      let materialized = 0;
      let linked = 0;
      let unmatched = 0;

      for (const intent of intents) {
        if (intent.provider === "SMTP_IMAP") {
          unmatched += 1;
          continue;
        }

        try {
          const mailbox = await mailboxService.getMailbox(intent.tenantId, intent.mailboxId);
          const providerAccount = await providerAccountRepository.findByMailboxId(intent.tenantId, intent.mailboxId);
          if (!providerAccount) {
            unmatched += 1;
            continue;
          }
          const adapter = providerRegistry.resolve(intent.provider);
          const credential = await resolveFreshCredential(
            intent.tenantId,
            providerAccount.id,
            adapter,
            credentialStore,
            auditRecorder,
          );
          if (!credential) {
            unmatched += 1;
            continue;
          }

          const providerMessageId = intent.lastResult?.providerMessageId;
          if (providerMessageId) {
            const already = await messageRepository.findByProviderMessageId(
              intent.tenantId,
              intent.mailboxId,
              intent.provider,
              providerMessageId,
            );
            if (already) {
              await messageRepository.linkExecutionIntent(intent.tenantId, already.id, intent.id);
              linked += 1;
              continue;
            }

            const fetched = await inboundProviders[intent.provider].getMessage(credential, providerMessageId);
            if (!fetched) {
              unmatched += 1;
              continue;
            }
            await conversationService.persistNormalized(
              intent.tenantId,
              intent.mailboxId,
              { ...fetched, direction: "OUTBOUND" },
              intent.id,
            );
            materialized += 1;
            continue;
          }

          if (intent.provider === "MICROSOFT365") {
            const recent = await graphInboundProvider.listRecentSent(credential);
            const matches = recent.filter((message) =>
              matchGraphSentItem(
                {
                  recipient: mailbox.emailAddressCanonical,
                  sentAt: intent.lastResult?.timestamp ?? new Date(0),
                },
                message,
              ),
            );
            if (matches.length !== 1) {
              unmatched += 1;
              continue;
            }
            await conversationService.persistNormalized(intent.tenantId, intent.mailboxId, matches[0]!, intent.id);
            materialized += 1;
            continue;
          }

          unmatched += 1;
        } catch (error) {
          unmatched += 1;
          logger.error({ err: error, intentId: intent.id }, "Outbound materializer failed for intent");
        }
      }

      return { considered: intents.length, materialized, linked, unmatched };
    },
  };
}
