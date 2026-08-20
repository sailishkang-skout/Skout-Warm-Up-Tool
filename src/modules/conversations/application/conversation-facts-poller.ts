import type { InboundSyncService, InboundSyncTickResult } from "./inbound-sync-service.js";
import type { OutboundMaterializer, OutboundMaterializerTickResult } from "./outbound-materializer.js";

export interface ConversationFactsTickResult {
  readonly inbound: InboundSyncTickResult;
  readonly outbound: OutboundMaterializerTickResult;
}

export interface ConversationFactsPoller {
  runTick(workerId: string): Promise<ConversationFactsTickResult>;
}

export function createConversationFactsPoller(
  inboundSyncService: InboundSyncService,
  outboundMaterializer: OutboundMaterializer,
): ConversationFactsPoller {
  return {
    async runTick(workerId: string): Promise<ConversationFactsTickResult> {
      const inbound = await inboundSyncService.runTick(workerId);
      const outbound = await outboundMaterializer.runTick();
      return { inbound, outbound };
    },
  };
}
