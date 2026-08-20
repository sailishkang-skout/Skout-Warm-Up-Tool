import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import type { ProviderConfigurationStatus } from "../../providers/domain/provider-adapter.js";
import type { ManagedDirectoryProvider, ManagedDirectoryResult } from "../domain/managed-directory-provider.js";
import { notConfiguredResult } from "../domain/managed-directory-provider.js";
import {
  directoryFailure,
  mapDirectoryHttpStatus,
  mapDirectoryTransportError,
  readProviderId,
} from "./directory-http.js";
import {
  createGoogleServiceAccountJwt,
  parseGoogleServiceAccountJson,
  type GoogleServiceAccount,
} from "./google-service-account-jwt.js";

const DIRECTORY_SCOPES = [
  "https://www.googleapis.com/auth/apps.order",
  "https://www.googleapis.com/auth/admin.directory.user",
  "https://www.googleapis.com/auth/admin.directory.domain",
] as const;

export interface GoogleWorkspaceDirectoryConfig {
  readonly adminEmail: string;
  readonly serviceAccount: GoogleServiceAccount;
}

export interface GoogleWorkspaceDirectoryOptions {
  readonly config?: GoogleWorkspaceDirectoryConfig;
  readonly fetchImpl?: typeof fetch;
  readonly getAccessToken?: () => Promise<string>;
  readonly allowLiveCalls?: boolean;
}

/**
 * Google Workspace reseller + Admin SDK directory adapter.
 * Unconfigured deployments return NOT_CONFIGURED and never invent IDs.
 * Live HTTP is used only when reseller config is present.
 */
export function createGoogleWorkspaceDirectoryProvider(
  options: GoogleWorkspaceDirectoryOptions | boolean = {},
): ManagedDirectoryProvider {
  const opts: GoogleWorkspaceDirectoryOptions = typeof options === "boolean" ? {} : options;
  const configured = typeof options === "boolean" ? options : Boolean(opts.config);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const allowLive = opts.allowLiveCalls === true;

  async function accessToken(): Promise<ManagedDirectoryResult<string>> {
    if (opts.getAccessToken) {
      return { ok: true, value: await opts.getAccessToken() };
    }
    if (!opts.config) {
      return notConfiguredResult();
    }
    if (!allowLive && process.env.ALLOW_LIVE_PROVIDER_TESTS !== "true" && process.env.NODE_ENV === "test") {
      return {
        ok: false,
        errorCode: "NOT_CONFIGURED",
        safeReason: "Live Google directory calls are disabled unless ALLOW_LIVE_PROVIDER_TESTS=true.",
      };
    }
    try {
      const jwt = createGoogleServiceAccountJwt(
        opts.config.serviceAccount,
        DIRECTORY_SCOPES,
        opts.config.adminEmail,
      );
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      });
      const response = await fetchImpl(opts.config.serviceAccount.tokenUri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const json = (await response.json()) as { access_token?: string };
      if (!response.ok || !json.access_token) {
        return { ok: false, errorCode: mapDirectoryHttpStatus(response.status), safeReason: "Google token endpoint rejected the reseller assertion." };
      }
      return { ok: true, value: json.access_token };
    } catch (error) {
      return { ok: false, errorCode: mapDirectoryTransportError(error), safeReason: "Could not obtain a Google reseller access token." };
    }
  }

  async function googleFetch(url: string, init: RequestInit): Promise<ManagedDirectoryResult<{ status: number; json: unknown }>> {
    const token = await accessToken();
    if (!token.ok || !token.value) {
      return directoryFailure(token.errorCode, token.safeReason);
    }
    incrementCounter(METRIC.directoryApiCall);
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        incrementCounter(METRIC.directoryApiFailure);
        return { ok: false, errorCode: mapDirectoryHttpStatus(response.status), safeReason: "Google directory API returned an error." };
      }
      return { ok: true, value: { status: response.status, json } };
    } catch (error) {
      incrementCounter(METRIC.directoryApiFailure);
      return { ok: false, errorCode: mapDirectoryTransportError(error), safeReason: "Google directory API was unreachable." };
    }
  }

  function requireConfigured<T>(): ManagedDirectoryResult<T> | undefined {
    if (!configured) {
      return notConfiguredResult();
    }
    return undefined;
  }

  return {
    provider: "GMAIL",
    getConfigurationStatus: (): ProviderConfigurationStatus => (configured ? "CONFIGURED" : "NOT_CONFIGURED"),

    async createCustomer(input) {
      const blocked = requireConfigured<{ providerCustomerId: string }>();
      if (blocked) {
        return blocked;
      }
      const created = await googleFetch("https://reseller.googleapis.com/apps/reseller/v1/customers", {
        method: "POST",
        body: JSON.stringify({ customerDomain: input.domain, alternateEmail: `admin@${input.domain}`, postalAddress: { contactName: input.displayName, organizationName: input.displayName, countryCode: "US" } }),
      });
      if (!created.ok) {
        if (created.errorCode === "ALREADY_EXISTS") {
          const existing = await googleFetch(
            `https://reseller.googleapis.com/apps/reseller/v1/customers/${encodeURIComponent(input.domain)}`,
            { method: "GET" },
          );
          const id = existing.ok ? readProviderId(existing.value?.json, ["customerId", "id"]) : undefined;
          if (id) {
            return { ok: true, value: { providerCustomerId: id } };
          }
          return { ok: false, errorCode: "ALREADY_EXISTS", safeReason: "Google reports the customer exists but did not return a customer id." };
        }
        return directoryFailure(created.errorCode, created.safeReason);
      }
      const id = readProviderId(created.value?.json, ["customerId", "id"]);
      if (!id) {
        return { ok: false, errorCode: "PROVIDER_NOT_READY", safeReason: "Google create-customer succeeded without a customer id." };
      }
      return { ok: true, value: { providerCustomerId: id } };
    },

    async getCustomer(input) {
      const blocked = requireConfigured<{ providerCustomerId: string; domain?: string }>();
      if (blocked) {
        return blocked;
      }
      const result = await googleFetch(
        `https://reseller.googleapis.com/apps/reseller/v1/customers/${encodeURIComponent(input.providerCustomerId)}`,
        { method: "GET" },
      );
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      const id = readProviderId(result.value?.json, ["customerId", "id"]);
      if (!id) {
        return { ok: false, errorCode: "NOT_FOUND", safeReason: "Google customer response did not include an id." };
      }
      const domain = readProviderId(result.value?.json, ["customerDomain"]);
      return { ok: true, value: { providerCustomerId: id, ...(domain ? { domain } : {}) } };
    },

    async verifyDomain(input) {
      const blocked = requireConfigured<{ verified: boolean }>();
      if (blocked) {
        return blocked;
      }
      const result = await googleFetch(
        `https://admin.googleapis.com/admin/directory/v1/customer/${encodeURIComponent(input.providerCustomerId)}/domains/${encodeURIComponent(input.domain)}`,
        { method: "GET" },
      );
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      const json = result.value?.json as { verified?: boolean } | undefined;
      if (json?.verified !== true) {
        return { ok: true, value: { verified: false } };
      }
      return { ok: true, value: { verified: true } };
    },

    async createMailbox(input) {
      const blocked = requireConfigured<{ providerMailboxId: string }>();
      if (blocked) {
        return blocked;
      }
      const existing = await googleFetch(
        `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(input.emailAddress)}`,
        { method: "GET" },
      );
      if (existing.ok) {
        const id = readProviderId(existing.value?.json, ["id"]);
        if (id) {
          return { ok: true, value: { providerMailboxId: id } };
        }
      }
      const created = await googleFetch("https://admin.googleapis.com/admin/directory/v1/users", {
        method: "POST",
        body: JSON.stringify({
          primaryEmail: input.emailAddress,
          name: { givenName: input.displayName ?? "Mailbox", familyName: "User", fullName: input.displayName ?? input.emailAddress },
          password: crypto.randomUUID().replace(/-/g, "") + "Aa1!",
          changePasswordAtNextLogin: true,
        }),
      });
      if (!created.ok) {
        return directoryFailure(created.errorCode, created.safeReason);
      }
      const id = readProviderId(created.value?.json, ["id"]);
      if (!id) {
        return { ok: false, errorCode: "PROVIDER_NOT_READY", safeReason: "Google create-user succeeded without a user id." };
      }
      return { ok: true, value: { providerMailboxId: id } };
    },

    async getMailbox(input) {
      const blocked = requireConfigured<{ providerMailboxId: string; emailAddress?: string }>();
      if (blocked) {
        return blocked;
      }
      const result = await googleFetch(
        `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(input.providerMailboxId)}`,
        { method: "GET" },
      );
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      const id = readProviderId(result.value?.json, ["id"]);
      if (!id) {
        return { ok: false, errorCode: "NOT_FOUND", safeReason: "Google user response did not include an id." };
      }
      const email = readProviderId(result.value?.json, ["primaryEmail"]);
      return { ok: true, value: { providerMailboxId: id, ...(email ? { emailAddress: email } : {}) } };
    },

    async suspendMailbox(input) {
      const blocked = requireConfigured<{ suspended: boolean }>();
      if (blocked) {
        return blocked;
      }
      const result = await googleFetch(
        `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(input.providerMailboxId)}`,
        { method: "PUT", body: JSON.stringify({ suspended: true }) },
      );
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      return { ok: true, value: { suspended: true } };
    },

    async restoreMailbox(input) {
      const blocked = requireConfigured<{ restored: boolean }>();
      if (blocked) {
        return blocked;
      }
      const result = await googleFetch(
        `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(input.providerMailboxId)}`,
        { method: "PUT", body: JSON.stringify({ suspended: false }) },
      );
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      return { ok: true, value: { restored: true } };
    },

    async deleteMailbox(input) {
      const blocked = requireConfigured<{ deleted: boolean }>();
      if (blocked) {
        return blocked;
      }
      const result = await googleFetch(
        `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(input.providerMailboxId)}`,
        { method: "DELETE" },
      );
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      return { ok: true, value: { deleted: true } };
    },

    async getHealth() {
      if (!configured) {
        return notConfiguredResult();
      }
      const token = await accessToken();
      if (!token.ok) {
        return { ok: true, value: { status: "DEGRADED" } };
      }
      return { ok: true, value: { status: "HEALTHY" } };
    },
  };
}

export { parseGoogleServiceAccountJson };
