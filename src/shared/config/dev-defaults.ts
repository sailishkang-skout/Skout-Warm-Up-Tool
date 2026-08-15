import type { EnvShape } from "./schema.js";

/**
 * Applied only when NODE_ENV !== "production" and only to fields left unset.
 * ENCRYPTION_KEY's default is deliberately obviously-fake so it can never be
 * mistaken for a real key if it leaks into a non-dev environment by accident.
 */
export const DEVELOPMENT_ENV_DEFAULTS: Partial<Record<keyof EnvShape, string>> = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/skout_warmup",
  REDIS_URL: "redis://localhost:6379",
  ENCRYPTION_KEY: "dev-only-insecure-encryption-key-do-not-use-in-prod",
};
