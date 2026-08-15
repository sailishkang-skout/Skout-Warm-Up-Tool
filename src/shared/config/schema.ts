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
export const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default("development"),
  SERVICE_NAME: z.string().min(1).default("skout-email-warmup-service"),
  SERVICE_VERSION: z.string().min(1).default("0.1.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3010),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  DATABASE_URL: z
    .string()
    .regex(POSTGRES_URL_PATTERN, "DATABASE_URL must be a postgres connection string"),
  REDIS_URL: z.string().regex(REDIS_URL_PATTERN, "REDIS_URL must be a redis connection string"),
  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY must be at least 32 characters"),
  // Reserved for Stage 4 bootstrap/admin auth wiring — no auth logic consumes this yet.
  API_KEY: z.string().min(16, "API_KEY must be at least 16 characters").optional(),
});

export type EnvShape = z.infer<typeof envSchema>;
