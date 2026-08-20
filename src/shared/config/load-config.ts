import { ConfigurationError } from "../errors/index.js";
import { DEVELOPMENT_ENV_DEFAULTS } from "./dev-defaults.js";
import { envSchema, type EnvShape, type LogLevelName, type NodeEnvName } from "./schema.js";

export interface AppConfig {
  readonly env: NodeEnvName;
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly service: { readonly name: string; readonly version: string };
    readonly http: { readonly port: number; readonly host: string; readonly bodyLimitBytes: number; readonly shutdownTimeoutMs: number };
  readonly log: { readonly level: LogLevelName };
  readonly database: {
    readonly url: string;
    readonly poolMin: number;
    readonly poolMax: number;
    readonly connectionTimeoutMs: number;
    readonly idleTimeoutMs: number;
    readonly statementTimeoutMs: number;
  };
  readonly redis: { readonly url: string };
  readonly security: { readonly encryptionKey: string; readonly apiKeyPepper: string };
  readonly providers: {
    readonly google?: { readonly clientId: string; readonly clientSecret: string; readonly redirectUri: string };
    readonly microsoft?: { readonly clientId: string; readonly clientSecret: string; readonly redirectUri: string };
    /** Stage 12.1 — see schema.ts's `PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS` doc comment. Applies to every OAuth-capable adapter, not per-provider, since both currently share the same reasoning. */
    readonly credentialRefreshTimeoutMs: number;
    readonly allowLiveProviderTests: boolean;
    readonly googleWorkspace?: { readonly adminEmail: string; readonly serviceAccountFile: string };
    readonly microsoftDirectory?: { readonly tenantId: string; readonly clientId: string; readonly clientSecret: string };
  };
  readonly ai: {
    readonly provider: "none" | "openai" | "openrouter";
    readonly apiKey?: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly timeoutMs: number;
    readonly maxInputChars: number;
    readonly maxOutputChars: number;
    readonly classifierVersion: string;
    readonly taxonomyVersion: string;
    readonly supplementDeterministic: boolean;
  };
  readonly conversations: {
    readonly policyVersion: string;
    readonly policyTaxonomyVersion: string;
  };
  readonly workers: {
    readonly warmupPollIntervalMs: number;
    readonly inboundPollIntervalMs: number;
    readonly classificationPollIntervalMs: number;
    readonly policyPollIntervalMs: number;
  };
  readonly warmupNetwork: {
    readonly routingMode: "off" | "prefer" | "require" | "internal" | "partner" | "hybrid";
    readonly exposeRecipientAddresses: boolean;
    readonly globalKillSwitch: boolean;
    readonly recentInteractionWindowMs: number;
    readonly defaultDailyCapacity: number;
    readonly minHealthScore: number;
    readonly cooldownMs: number;
    readonly requireSpf: boolean;
    readonly requireDkim: boolean;
    readonly requireDmarc: boolean;
  };
  readonly warmupPool: {
    readonly selectionStrategy:
      | "ROUND_ROBIN"
      | "LEAST_USED"
      | "WEIGHTED"
      | "HEALTH_FIRST"
      | "HEALTH_FIRST_LEAST_USED";
    readonly maxDomainSharePercent: number;
    readonly maxConsecutiveSameDomain: number;
    readonly selectionCooldownMs: number;
  };
}

const POOL_STRATEGY_ENV: Record<string, AppConfig["warmupPool"]["selectionStrategy"]> = {
  round_robin: "ROUND_ROBIN",
  least_used: "LEAST_USED",
  weighted: "WEIGHTED",
  health_first: "HEALTH_FIRST",
  health_first_least_used: "HEALTH_FIRST_LEAST_USED",
};

/**
 * Treats an empty string the same as "unset". `.env` files and this repo's
 * own `.env.example` ship optional secrets as blank (`ENCRYPTION_KEY=`)
 * rather than omitted, and a blank string should not be able to satisfy a
 * `.min(n)` check by accident, nor block a dev default from applying.
 */
function normalizeEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    normalized[key] = value === "" ? undefined : value;
  }
  return normalized;
}

function applyDevelopmentDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.NODE_ENV === "production") {
    return env;
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [key, defaultValue] of Object.entries(DEVELOPMENT_ENV_DEFAULTS)) {
    merged[key] ??= defaultValue;
  }
  return merged;
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function toAppConfig(env: EnvShape): AppConfig {
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === "production",
    isDevelopment: env.NODE_ENV === "development",
    isTest: env.NODE_ENV === "test",
    service: { name: env.SERVICE_NAME, version: env.SERVICE_VERSION },
    http: {
      port: env.PORT,
      host: env.HTTP_HOST,
      bodyLimitBytes: env.HTTP_BODY_LIMIT_BYTES,
      shutdownTimeoutMs: env.HTTP_SHUTDOWN_TIMEOUT_MS,
    },
    log: { level: env.LOG_LEVEL },
    database: {
      url: env.DATABASE_URL,
      poolMin: env.DB_POOL_MIN,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    },
    redis: { url: env.REDIS_URL },
    security: {
      encryptionKey: env.ENCRYPTION_KEY,
      apiKeyPepper: env.API_KEY_PEPPER,
    },
    providers: {
      // The schema's `.check()` already guarantees each triplet is
      // all-or-nothing, so checking just one field here is enough to know
      // whether the whole group is present.
      ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
              redirectUri: env.GOOGLE_REDIRECT_URI,
            },
          }
        : {}),
      ...(env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.MICROSOFT_REDIRECT_URI
        ? {
            microsoft: {
              clientId: env.MICROSOFT_CLIENT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
              redirectUri: env.MICROSOFT_REDIRECT_URI,
            },
          }
        : {}),
      credentialRefreshTimeoutMs: env.PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS,
      allowLiveProviderTests: env.ALLOW_LIVE_PROVIDER_TESTS === "true",
      ...(env.GOOGLE_WORKSPACE_ADMIN_EMAIL && env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE
        ? {
            googleWorkspace: {
              adminEmail: env.GOOGLE_WORKSPACE_ADMIN_EMAIL,
              serviceAccountFile: env.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_FILE,
            },
          }
        : {}),
      ...(env.MICROSOFT_CSP_TENANT_ID && env.MICROSOFT_CSP_CLIENT_ID && env.MICROSOFT_CSP_CLIENT_SECRET
        ? {
            microsoftDirectory: {
              tenantId: env.MICROSOFT_CSP_TENANT_ID,
              clientId: env.MICROSOFT_CSP_CLIENT_ID,
              clientSecret: env.MICROSOFT_CSP_CLIENT_SECRET,
            },
          }
        : {}),
    },
    ai: {
      provider: env.AI_CLASSIFICATION_PROVIDER,
      ...(env.AI_API_KEY ? { apiKey: env.AI_API_KEY } : {}),
      baseUrl:
        env.AI_BASE_URL ??
        (env.AI_CLASSIFICATION_PROVIDER === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1"),
      model: env.AI_MODEL,
      timeoutMs: env.AI_CLASSIFICATION_TIMEOUT_MS,
      maxInputChars: env.AI_MAX_INPUT_CHARS,
      maxOutputChars: env.AI_MAX_OUTPUT_CHARS,
      classifierVersion: env.AI_CLASSIFIER_VERSION,
      taxonomyVersion: env.CLASSIFICATION_TAXONOMY_VERSION,
      supplementDeterministic: env.AI_CLASSIFICATION_SUPPLEMENT === "true",
    },
    conversations: {
      policyVersion: env.CONVERSATION_POLICY_VERSION,
      policyTaxonomyVersion: env.CONVERSATION_POLICY_TAXONOMY_VERSION,
    },
    workers: {
      warmupPollIntervalMs: env.WARMUP_WORKER_POLL_INTERVAL_MS,
      inboundPollIntervalMs: env.INBOUND_WORKER_POLL_INTERVAL_MS,
      classificationPollIntervalMs: env.CLASSIFICATION_WORKER_POLL_INTERVAL_MS,
      policyPollIntervalMs: env.POLICY_WORKER_POLL_INTERVAL_MS,
    },
    warmupNetwork: {
      routingMode: env.WARMUP_NETWORK_ROUTING_MODE,
      exposeRecipientAddresses: env.WARMUP_NETWORK_EXPOSE_RECIPIENT_ADDRESSES === "true",
      globalKillSwitch: env.WARMUP_KILL_SWITCH_GLOBAL === "true",
      recentInteractionWindowMs: env.WARMUP_NETWORK_RECENT_INTERACTION_WINDOW_MS,
      defaultDailyCapacity: env.WARMUP_NETWORK_DEFAULT_DAILY_CAPACITY,
      minHealthScore: env.WARMUP_NETWORK_MIN_HEALTH_SCORE,
      cooldownMs: env.WARMUP_NETWORK_COOLDOWN_MS,
      requireSpf: env.WARMUP_NETWORK_REQUIRE_SPF === "true",
      requireDkim: env.WARMUP_NETWORK_REQUIRE_DKIM === "true",
      requireDmarc: env.WARMUP_NETWORK_REQUIRE_DMARC === "true",
    },
    warmupPool: {
      selectionStrategy: POOL_STRATEGY_ENV[env.WARMUP_POOL_SELECTION_STRATEGY] ?? "HEALTH_FIRST_LEAST_USED",
      maxDomainSharePercent: env.WARMUP_MAX_DOMAIN_SHARE_PERCENT,
      maxConsecutiveSameDomain: env.WARMUP_MAX_CONSECUTIVE_SAME_DOMAIN,
      selectionCooldownMs: env.WARMUP_POOL_SELECTION_COOLDOWN_MS,
    },
  };
}

/**
 * Validates and normalizes the process environment into a typed `AppConfig`.
 * Throws `ConfigurationError` — never returns a partially-valid config — so
 * callers can fail startup fast instead of running with broken settings.
 */
export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  const resolved = applyDevelopmentDefaults(normalizeEnv(rawEnv));
  const result = envSchema.safeParse(resolved);

  if (!result.success) {
    throw new ConfigurationError(
      `Invalid environment configuration: ${formatIssues(result.error.issues)}`,
    );
  }

  return toAppConfig(result.data);
}
