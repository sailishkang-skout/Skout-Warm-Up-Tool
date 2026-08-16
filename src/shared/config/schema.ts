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
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    DATABASE_URL: z
      .string()
      .regex(POSTGRES_URL_PATTERN, "DATABASE_URL must be a postgres connection string"),
    REDIS_URL: z.string().regex(REDIS_URL_PATTERN, "REDIS_URL must be a redis connection string"),
    DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
    DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
    DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(0).default(5000),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30000),
    ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
    // HMAC pepper for API credential hashing — see src/modules/auth/domain/api-key-hash.ts
    // for why HMAC-SHA256 rather than a password KDF, and why a pepper at all.
    API_KEY_PEPPER: z.string().min(32, "API_KEY_PEPPER must be at least 32 characters"),
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
