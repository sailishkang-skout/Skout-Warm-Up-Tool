import { incrementCounter, METRIC } from "../../../shared/observability/index.js";
import type { ProviderConfigurationStatus } from "../../providers/domain/provider-adapter.js";
import type { ManagedDirectoryProvider, ManagedDirectoryResult } from "../domain/managed-directory-provider.js";
import { notConfiguredResult } from "../domain/managed-directory-provider.js";
import { directoryFailure, mapDirectoryHttpStatus, mapDirectoryTransportError, readProviderId } from "./directory-http.js";

export interface Microsoft365DirectoryConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly graphBaseUrl?: string;
  readonly tokenUrl?: string;
}

export interface Microsoft365DirectoryOptions {
  readonly config?: Microsoft365DirectoryConfig;
  readonly fetchImpl?: typeof fetch;
  readonly getAccessToken?: () => Promise<string>;
  readonly allowLiveCalls?: boolean;
}

export function createMicrosoft365DirectoryProvider(
  options: Microsoft365DirectoryOptions | boolean = {},
): ManagedDirectoryProvider {
  const opts: Microsoft365DirectoryOptions = typeof options === "boolean" ? {} : options;
  const configured = typeof options === "boolean" ? options : Boolean(opts.config);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const graphBase = opts.config?.graphBaseUrl ?? "https://graph.microsoft.com/v1.0";

  async function accessToken(): Promise<ManagedDirectoryResult<string>> {
    if (opts.getAccessToken) {
      return { ok: true, value: await opts.getAccessToken() };
    }
    if (!opts.config) {
      return notConfiguredResult();
    }
    if (!opts.allowLiveCalls && process.env.ALLOW_LIVE_PROVIDER_TESTS !== "true" && process.env.NODE_ENV === "test") {
      return {
        ok: false,
        errorCode: "NOT_CONFIGURED",
        safeReason: "Live Microsoft directory calls are disabled unless ALLOW_LIVE_PROVIDER_TESTS=true.",
      };
    }
    try {
      const tokenUrl =
        opts.config.tokenUrl ??
        `https://login.microsoftonline.com/${encodeURIComponent(opts.config.tenantId)}/oauth2/v2.0/token`;
      const body = new URLSearchParams({
        client_id: opts.config.clientId,
        client_secret: opts.config.clientSecret,
        grant_type: "client_credentials",
        scope: "https://graph.microsoft.com/.default",
      });
      const response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const json = (await response.json()) as { access_token?: string };
      if (!response.ok || !json.access_token) {
        return { ok: false, errorCode: mapDirectoryHttpStatus(response.status), safeReason: "Microsoft token endpoint rejected the CSP client credentials." };
      }
      return { ok: true, value: json.access_token };
    } catch (error) {
      return { ok: false, errorCode: mapDirectoryTransportError(error), safeReason: "Could not obtain a Microsoft Graph access token." };
    }
  }

  async function graphFetch(path: string, init: RequestInit): Promise<ManagedDirectoryResult<{ json: unknown }>> {
    const token = await accessToken();
    if (!token.ok || !token.value) {
      return directoryFailure(token.errorCode, token.safeReason);
    }
    incrementCounter(METRIC.directoryApiCall);
    try {
      const response = await fetchImpl(`${graphBase}${path}`, {
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
        return { ok: false, errorCode: mapDirectoryHttpStatus(response.status), safeReason: "Microsoft Graph returned an error." };
      }
      return { ok: true, value: { json } };
    } catch (error) {
      incrementCounter(METRIC.directoryApiFailure);
      return { ok: false, errorCode: mapDirectoryTransportError(error), safeReason: "Microsoft Graph was unreachable." };
    }
  }

  function requireConfigured<T>(): ManagedDirectoryResult<T> | undefined {
    if (!configured) {
      return notConfiguredResult();
    }
    return undefined;
  }

  return {
    provider: "MICROSOFT365",
    getConfigurationStatus: (): ProviderConfigurationStatus => (configured ? "CONFIGURED" : "NOT_CONFIGURED"),

    async createCustomer() {
      return {
        ok: false,
        errorCode: "NOT_CONFIGURED",
        safeReason:
          "Microsoft customer-tenant creation requires Partner Center / CSP authorization, which is not configured. Existing customer tenants can still receive Graph mailbox operations.",
      };
    },

    async getCustomer(input) {
      const blocked = requireConfigured<{ providerCustomerId: string }>();
      if (blocked) {
        return blocked;
      }
      const result = await graphFetch("/organization", { method: "GET" });
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      const value = result.value?.json as { value?: Array<{ id?: string }> };
      const id = value?.value?.[0]?.id;
      if (!id) {
        return { ok: false, errorCode: "NOT_FOUND", safeReason: "Graph organization listing did not include a tenant id." };
      }
      if (id !== input.providerCustomerId && input.providerCustomerId !== "me") {
        return { ok: false, errorCode: "NOT_FOUND", safeReason: "Graph organization id did not match the requested customer id." };
      }
      return { ok: true, value: { providerCustomerId: id } };
    },

    async verifyDomain(input) {
      const blocked = requireConfigured<{ verified: boolean }>();
      if (blocked) {
        return blocked;
      }
      const result = await graphFetch(`/domains/${encodeURIComponent(input.domain)}`, { method: "GET" });
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      const json = result.value?.json as { isVerified?: boolean };
      return { ok: true, value: { verified: json.isVerified === true } };
    },

    async createMailbox(input) {
      const blocked = requireConfigured<{ providerMailboxId: string }>();
      if (blocked) {
        return blocked;
      }
      const existing = await graphFetch(`/users/${encodeURIComponent(input.emailAddress)}`, { method: "GET" });
      if (existing.ok) {
        const id = readProviderId(existing.value?.json, ["id"]);
        if (id) {
          return { ok: true, value: { providerMailboxId: id } };
        }
      }
      const local = input.emailAddress.split("@")[0] ?? "user";
      const created = await graphFetch("/users", {
        method: "POST",
        body: JSON.stringify({
          accountEnabled: true,
          displayName: input.displayName ?? input.emailAddress,
          mailNickname: local,
          userPrincipalName: input.emailAddress,
          passwordProfile: { forceChangePasswordNextSignIn: true, password: crypto.randomUUID().replace(/-/g, "") + "Aa1!" },
        }),
      });
      if (!created.ok) {
        return directoryFailure(created.errorCode, created.safeReason);
      }
      const id = readProviderId(created.value?.json, ["id"]);
      if (!id) {
        return { ok: false, errorCode: "PROVIDER_NOT_READY", safeReason: "Graph create-user succeeded without an id." };
      }
      return { ok: true, value: { providerMailboxId: id } };
    },

    async getMailbox(input) {
      const blocked = requireConfigured<{ providerMailboxId: string; emailAddress?: string }>();
      if (blocked) {
        return blocked;
      }
      const result = await graphFetch(`/users/${encodeURIComponent(input.providerMailboxId)}`, { method: "GET" });
      if (!result.ok) {
        return directoryFailure(result.errorCode, result.safeReason);
      }
      const id = readProviderId(result.value?.json, ["id"]);
      if (!id) {
        return { ok: false, errorCode: "NOT_FOUND", safeReason: "Graph user response did not include an id." };
      }
      const email = readProviderId(result.value?.json, ["userPrincipalName", "mail"]);
      return { ok: true, value: { providerMailboxId: id, ...(email ? { emailAddress: email } : {}) } };
    },

    async suspendMailbox(input) {
      const blocked = requireConfigured<{ suspended: boolean }>();
      if (blocked) {
        return blocked;
      }
      const result = await graphFetch(`/users/${encodeURIComponent(input.providerMailboxId)}`, {
        method: "PATCH",
        body: JSON.stringify({ accountEnabled: false }),
      });
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
      const result = await graphFetch(`/users/${encodeURIComponent(input.providerMailboxId)}`, {
        method: "PATCH",
        body: JSON.stringify({ accountEnabled: true }),
      });
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
      const result = await graphFetch(`/users/${encodeURIComponent(input.providerMailboxId)}`, { method: "DELETE" });
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
