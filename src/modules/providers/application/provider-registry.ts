import { ConfigurationError } from "../../../shared/errors/index.js";
import type { MailboxProviderType } from "../../mailbox/domain/mailbox.js";
import type { ProviderAdapter } from "../domain/provider-adapter.js";

/**
 * Lets application code ask for "the adapter for this mailbox's provider
 * type" without a switch statement anywhere outside the composition root,
 * where registration happens once at startup.
 */
export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  resolve(providerType: MailboxProviderType): ProviderAdapter;
}

export function createProviderRegistry(): ProviderRegistry {
  const adapters = new Map<MailboxProviderType, ProviderAdapter>();

  return {
    register(adapter: ProviderAdapter): void {
      if (adapters.has(adapter.providerType)) {
        throw new ConfigurationError(`A provider adapter for '${adapter.providerType}' is already registered`);
      }
      adapters.set(adapter.providerType, adapter);
    },

    resolve(providerType: MailboxProviderType): ProviderAdapter {
      const adapter = adapters.get(providerType);
      if (!adapter) {
        throw new ConfigurationError(`No provider adapter is registered for '${providerType}'`);
      }
      return adapter;
    },
  };
}
