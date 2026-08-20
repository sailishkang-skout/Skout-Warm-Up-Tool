import type { AuditEventRecorder } from "../../audit/application/audit-event-recorder.js";
import type { MailboxService } from "../../mailbox/application/mailbox-service.js";
import type { ProviderAccountRepository } from "../../providers/application/provider-account-repository.js";
import type { ProviderCredentialStore } from "../../providers/application/provider-credential-store.js";
import type { ProviderRegistry } from "../../providers/application/provider-registry.js";
import { resolveFreshCredential } from "../../providers/application/resolve-fresh-credential.js";
import type { Database } from "../../../shared/db/index.js";
import type { Logger } from "../../../shared/logger/index.js";
import { HistoryCursorInvalidError } from "../domain/normalized-inbound.js";
import type { ConversationService, PersistNormalizedResult } from "./conversation-service.js";
import type { InboundMessageProvider } from "./inbound-message-provider.js";
import type { InboundSyncStateRepository } from "./inbound-sync-state-repository.js";
import type { PollableMailbox } from "../infrastructure/pollable-mailbox-reader.js";

const LEASE_DURATION_MS = 60_000;
const RECLAIM_LIMIT = 50;
const CLAIM_BATCH = 10;

export interface InboundSyncTickResult {
  readonly reclaimedLeases: number;
  readonly mailboxesEnsured: number;
  readonly mailboxesProcessed: number;
  readonly messagesInserted: number;
}

export interface InboundSyncService {
  runTick(workerId: string): Promise<InboundSyncTickResult>;
}

export interface CreateInboundSyncServiceDeps {
  readonly database: Database;
  readonly mailboxService: MailboxService;
  readonly providerRegistry: ProviderRegistry;
  readonly providerAccountRepository: ProviderAccountRepository;
  readonly credentialStore: ProviderCredentialStore;
  readonly auditRecorder: AuditEventRecorder;
  readonly conversationService: ConversationService;
  readonly syncStateRepository: InboundSyncStateRepository;
  readonly listPollableMailboxes: () => Promise<readonly PollableMailbox[]>;
  readonly inboundProviders: Readonly<Record<"GMAIL" | "MICROSOFT365", InboundMessageProvider>>;
  readonly logger: Logger;
}

export function createInboundSyncService(deps: CreateInboundSyncServiceDeps): InboundSyncService {
  const {
    database,
    mailboxService,
    providerRegistry,
    providerAccountRepository,
    credentialStore,
    auditRecorder,
    conversationService,
    syncStateRepository,
    listPollableMailboxes,
    inboundProviders,
    logger,
  } = deps;

  return {
    async runTick(workerId: string): Promise<InboundSyncTickResult> {
      const reclaimed = await syncStateRepository.reclaimExpiredLeases(new Date(), RECLAIM_LIMIT);
      const pollable = await listPollableMailboxes();
      for (const mailbox of pollable) {
        await syncStateRepository.ensure(mailbox.tenantId, mailbox.mailboxId, mailbox.provider);
      }

      let mailboxesProcessed = 0;
      let messagesInserted = 0;

      for (let i = 0; i < CLAIM_BATCH; i += 1) {
        const claimed = await syncStateRepository.claimNext(workerId, LEASE_DURATION_MS);
        if (!claimed) {
          break;
        }
        mailboxesProcessed += 1;
        try {
          const mailbox = await mailboxService.getMailbox(claimed.tenantId, claimed.mailboxId);
          const providerAccount = await providerAccountRepository.findByMailboxId(claimed.tenantId, claimed.mailboxId);
          const adapter = providerRegistry.resolve(claimed.provider);
          if (!providerAccount) {
            await syncStateRepository.completeFailure(claimed.id, workerId, "No provider account is connected for this mailbox.");
            continue;
          }
          const credential = await resolveFreshCredential(
            claimed.tenantId,
            providerAccount.id,
            adapter,
            credentialStore,
            auditRecorder,
          );
          if (!credential) {
            await syncStateRepository.completeFailure(claimed.id, workerId, "No usable credential is stored for this mailbox.");
            continue;
          }

          const inbound = inboundProviders[claimed.provider];
          const changes = await inbound.listChanges(credential, claimed.cursor);
          const persisted: PersistNormalizedResult[] = [];

          await database.withTransaction(async (client) => {
            for (const message of changes.messages) {
              const result = await conversationService.persistOnClient(
                client,
                claimed.tenantId,
                claimed.mailboxId,
                message,
              );
              persisted.push(result);
            }
            await syncStateRepository.completeSuccess(client, claimed.id, workerId, changes.nextCursor ?? claimed.cursor);
          });

          for (const result of persisted) {
            await conversationService.emitPersistAudits(result);
            if (result.messageInserted) {
              messagesInserted += 1;
            }
          }
        } catch (error) {
          if (error instanceof HistoryCursorInvalidError) {
            await syncStateRepository.completeFailure(claimed.id, workerId, error.message);
            logger.warn({ mailboxId: claimed.mailboxId, provider: claimed.provider }, error.message);
            continue;
          }
          const safe = error instanceof Error ? error.message.slice(0, 300) : "Inbound sync failed";
          await syncStateRepository.completeFailure(claimed.id, workerId, safe);
          logger.error({ err: error, mailboxId: claimed.mailboxId }, "Inbound sync mailbox failed");
        }
      }

      return {
        reclaimedLeases: reclaimed.length,
        mailboxesEnsured: pollable.length,
        mailboxesProcessed,
        messagesInserted,
      };
    },
  };
}
