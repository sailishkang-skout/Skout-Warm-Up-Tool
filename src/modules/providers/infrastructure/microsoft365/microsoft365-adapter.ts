import { ProviderError } from "../../../../shared/errors/index.js";
import type {
  ProviderAdapter,
  ProviderConfigurationStatus,
  ProviderMailboxIdentity,
} from "../../domain/provider-adapter.js";
import type { ProviderCapabilities } from "../../domain/provider-capabilities.js";
import type { ProviderConnectionValidationResult } from "../../domain/provider-connection-validation.js";
import type { ProviderCredential } from "../../domain/provider-credential.js";
import type { ProviderHealthResult } from "../../domain/provider-health.js";

const PROVIDER_TYPE = "MICROSOFT365" as const;

const CAPABILITIES: ProviderCapabilities = {
  canSend: true,
  canReceive: true,
  supportsThreads: true,
  supportsFolders: true, // Outlook/Graph has a real folder hierarchy
  supportsOAuth: true,
  supportsSmtp: false,
  supportsImap: false,
};

/**
 * Stage 5 skeleton — see this module's README (../../README.md) for the
 * required external configuration once real OAuth/Graph access is
 * implemented. Every method here is honest about doing nothing real yet.
 */
export class Microsoft365Adapter implements ProviderAdapter {
  readonly providerType = PROVIDER_TYPE;

  getCapabilities(): ProviderCapabilities {
    return CAPABILITIES;
  }

  getConfigurationStatus(): ProviderConfigurationStatus {
    return "NOT_CONFIGURED";
  }

  async validateConnection(
    credential: ProviderCredential | undefined,
  ): Promise<ProviderConnectionValidationResult> {
    return {
      status: credential ? "PROVIDER_ERROR" : "NOT_CONFIGURED",
      message: credential
        ? "Microsoft 365 OAuth is not yet implemented for this deployment; a credential was supplied but cannot be validated."
        : "Microsoft 365 OAuth is not yet implemented for this deployment.",
      checkedAt: new Date(),
    };
  }

  async getMailboxIdentity(_credential: ProviderCredential | undefined): Promise<ProviderMailboxIdentity> {
    throw new ProviderError(PROVIDER_TYPE, "Microsoft 365 integration is not yet implemented", {
      retryable: false,
    });
  }

  async getConnectionHealth(_credential: ProviderCredential | undefined): Promise<ProviderHealthResult> {
    return {
      status: "UNKNOWN",
      providerType: PROVIDER_TYPE,
      checkedAt: new Date(),
      message: "Microsoft 365 integration is not yet implemented.",
    };
  }
}
