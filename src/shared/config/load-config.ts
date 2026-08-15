import { ConfigurationError } from "../errors/index.js";
import { DEVELOPMENT_ENV_DEFAULTS } from "./dev-defaults.js";
import { envSchema, type EnvShape, type LogLevelName, type NodeEnvName } from "./schema.js";

export interface AppConfig {
  readonly env: NodeEnvName;
  readonly isProduction: boolean;
  readonly isDevelopment: boolean;
  readonly isTest: boolean;
  readonly service: { readonly name: string; readonly version: string };
  readonly http: { readonly port: number };
  readonly log: { readonly level: LogLevelName };
  readonly database: {
    readonly url: string;
    readonly poolMin: number;
    readonly poolMax: number;
    readonly connectionTimeoutMs: number;
    readonly idleTimeoutMs: number;
  };
  readonly redis: { readonly url: string };
  readonly security: { readonly encryptionKey: string; readonly apiKey?: string };
}

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
    http: { port: env.PORT },
    log: { level: env.LOG_LEVEL },
    database: {
      url: env.DATABASE_URL,
      poolMin: env.DB_POOL_MIN,
      poolMax: env.DB_POOL_MAX,
      connectionTimeoutMs: env.DB_CONNECTION_TIMEOUT_MS,
      idleTimeoutMs: env.DB_IDLE_TIMEOUT_MS,
    },
    redis: { url: env.REDIS_URL },
    security: {
      encryptionKey: env.ENCRYPTION_KEY,
      ...(env.API_KEY ? { apiKey: env.API_KEY } : {}),
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
