import { z } from "zod";

export const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnvName = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\/\S+$/;
const REDIS_URL_PATTERN = /^rediss?:\/\/\S+$/;

/**
 * The environment surface this service depends on. DATABASE_URL, REDIS_URL,
 * and ENCRYPTION_KEY are required here unconditionally — dev/test convenience
 * defaults are layered on top of the *raw* env before parsing (see
 * `load-config.ts`), never expressed as schema defaults, so that a missing
 * value in production still fails validation instead of silently defaulting.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(NODE_ENVS).default("development"),
    SERVICE_NAME: z.string().min(1).default("skout-email-warmup-service"),
    SERVICE_VERSION: z.string().min(1).default("0.1.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3010),
    // Prefer HTTP_PORT when set — avoids collisions if shell scripts clobber PORT.
    HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    HTTP_HOST: z.string().min(1).default("0.0.0.0"),
    HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(1_048_576),
    HTTP_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    DATABASE_URL: z
      .string()
      .regex(POSTGRES_URL_PATTERN, "DATABASE_URL must be a postgres connection string"),
    REDIS_URL: z.string().regex(REDIS_URL_PATTERN, "REDIS_URL must be a redis connection string"),
    DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).default(5000),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30000),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
    // Stage 12.1: bounds the OAuth access-token refresh network call
    // (`resolve-fresh-credential.ts` -> `adapter.oauth.refreshAccessToken`)
    // — independent from the providers' own SEND_TIMEOUT_MS (15_000,
    // hardcoded per-adapter, unrelated to this value). 10s is comfortably
    // longer than a normal token-endpoint round trip (a small POST/JSON
    // response, no message payload) while still keeping the worst-case
    // credential-refresh-then-send critical section (this + each
    // adapter's own 15s send timeout) safely under the execution worker's
    // 60s lease even without lease-heartbeat renewal factored in.
    PROVIDER_CREDENTIAL_REFRESH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
    ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
    // HMAC pepper for API credential hashing — see src/modules/auth/domain/api-key-hash.ts
    // for why HMAC-SHA256 rather than a password KDF, and why a pepper at all.
    API_KEY_PEPPER: z.string().min(32, "API_KEY_PEPPER must be at least 32 characters"),
    // Service-to-service key for Skout platform tenant provisioning. Optional —
    // when unset, POST /api/v1/internal/provision-tenant returns 503.
    PLATFORM_PROVISIONING_KEY: z.string().min(32).optional(),
    AI_CLASSIFICATION_PROVIDER: z.enum(["none", "openai", "openrouter"]).default("none"),
    AI_API_KEY: z.string().min(1).optional(),
    AI_BASE_URL: z.string().url().optional(),
    AI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
    AI_CLASSIFICATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
    AI_MAX_INPUT_CHARS: z.coerce.number().int().min(256).default(8_000),
    AI_MAX_OUTPUT_CHARS: z.coerce.number().int().min(256).default(2_000),
    AI_CLASSIFIER_VERSION: z.string().min(1).default("conversation-classifier/v1"),
    CLASSIFICATION_TAXONOMY_VERSION: z.string().min(1).default("classification-taxonomy/v1"),
    CONVERSATION_POLICY_VERSION: z.string().min(1).default("conversation-policy/v1"),
    CONVERSATION_POLICY_TAXONOMY_VERSION: z.string().min(1).default("conversation-policy-taxonomy/v1"),
    AI_CLASSIFICATION_SUPPLEMENT: z.enum(["true", "false"]).default("false"),
    WARMUP_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
    INBOUND_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
    CLASSIFICATION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
    POLICY_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
    // Google/Microsoft OAuth: each provider's three values are optional as a
    // *group* — a deployment that never connects Gmail/M365 mailboxes must
    // not be forced to fabricate OAuth client secrets it will never use.
    // The `.check()` below enforces "all three or none" per provider so a
    // half-configured provider fails startup instead of silently behaving
    // as NOT_CONFIGURED when someone meant to enable it (see load-config.ts).
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().url().optional(),
    MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
    MICROSOFT_CLIENT_SECRET: z.string().min(1).optional(),
    MICROSOFT_REDIRECT_URI: z.string().url().optional(),
    WARMUP_NETWORK_ROUTING_MODE: z.enum(["off", "prefer", "require", "internal", "partner", "hybrid"]).default("off"),
    WARMUP_NETWORK_EXPOSE_RECIPIENT_ADDRESSES: z.enum(["true", "false"]).default("false"),
    WARMUP_KILL_SWITCH_GLOBAL: z.enum(["true", "false"]).default("false"),
    WARMUP_NETWORK_RECENT_INTERACTION_WINDOW_MS: z.coerce.number().int().min(0).default(604_800_000),
    WARMUP_NETWORK_DEFAULT_DAILY_CAPACITY: z.coerce.number().int().min(0).default(50),
    WARMUP_NETWORK_MIN_HEALTH_SCORE: z.coerce.number().int().min(0).max(100).default(50),
    WARMUP_NETWORK_COOLDOWN_MS: z.coerce.number().int().min(0).default(3_600_000),
    WARMUP_NETWORK_REQUIRE_SPF: z.enum(["true", "false"]).default("true"),
    WARMUP_NETWORK_REQUIRE_DKIM: z.enum(["true", "false"]).default("true"),
    WARMUP_NETWORK_REQUIRE_DMARC: z.enum(["true", "false"]).default("true"),
    WARMUP_POOL_SELECTION_STRATEGY: z
      .enum(["round_robin", "least_used", "weighted", "health_first", "health_first_least_used"])
      .default("health_first_least_used"),
    WARMUP_MAX_DOMAIN_SHARE_PERCENT: z.coerce.number().int().min(1).max(100).default(70),
    WARMUP_MAX_CONSECUTIVE_SAME_DOMAIN: z.coerce.number().int().min(1).default(2),
    WARMUP_POOL_SELECTION_COOLDOWN_MS: z.coerce.number().int().min(0).default(0),
  })
  .check((ctx) => {
    if (ctx.value.DB_POOL_MIN > ctx.value.DB_POOL_MAX) {
      ctx.issues.push({
        code: "custom",
        message: "DB_POOL_MIN must not be greater than DB_POOL_MAX",
        path: ["DB_POOL_MIN"],
        input: ctx.value,
      });
    }

    const googleFields = [ctx.value.GOOGLE_CLIENT_ID, ctx.value.GOOGLE_CLIENT_SECRET, ctx.value.GOOGLE_REDIRECT_URI];
    if (new Set(googleFields.map((v) => v === undefined)).size > 1) {
      ctx.issues.push({
        code: "custom",
        message:
          "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI must be set together, or not at all",
        path: ["GOOGLE_CLIENT_ID"],
        input: ctx.value,
      });
    }

    if (ctx.value.AI_CLASSIFICATION_PROVIDER !== "none" && ctx.value.AI_API_KEY === undefined) {
      ctx.issues.push({
        code: "custom",
        message: "AI_API_KEY is required when AI_CLASSIFICATION_PROVIDER is not none",
        path: ["AI_API_KEY"],
        input: ctx.value,
      });
    }
    const microsoftFields = [
      ctx.value.MICROSOFT_CLIENT_ID,
      ctx.value.MICROSOFT_CLIENT_SECRET,
      ctx.value.MICROSOFT_REDIRECT_URI,
    ];
    if (new Set(microsoftFields.map((v) => v === undefined)).size > 1) {
      ctx.issues.push({
        code: "custom",
        message:
          "MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and MICROSOFT_REDIRECT_URI must be set together, or not at all",
        path: ["MICROSOFT_CLIENT_ID"],
        input: ctx.value,
      });
    }
  });

export type EnvShape = z.infer<typeof envSchema>;
