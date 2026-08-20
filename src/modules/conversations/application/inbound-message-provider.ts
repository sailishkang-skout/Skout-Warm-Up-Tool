import type { ProviderCredential } from "../../providers/domain/provider-credential.js";
import type { HistoryCursorInvalidError, ListChangesResult, NormalizedInbound } from "../domain/normalized-inbound.js";

export interface InboundMessageProvider {
  listChanges(credential: ProviderCredential, cursor: string | undefined): Promise<ListChangesResult>;
  getMessage(credential: ProviderCredential, providerMessageId: string): Promise<NormalizedInbound | null>;
}

export type { HistoryCursorInvalidError };
