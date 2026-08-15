import type { EnvShape } from "./schema.js";

/**
 * Applied only when NODE_ENV !== "production" and only to fields left unset.
 * ENCRYPTION_KEY's default is deliberately obviously-fake so it can never be
 * mistaken for a real key if it leaks into a non-dev environment by accident.
 *
 * Ports 5433/6380 (not 5432/6379) deliberately: this service must be
 * independently deployable and must never assume — let alone collide with —
 * infrastructure from another Skout repository's docker-compose stack that
 * may already be running on a shared dev machine.
 */
export const DEVELOPMENT_ENV_DEFAULTS: Partial<Record<keyof EnvShape, string>> = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/skout_warmup",
  REDIS_URL: "redis://localhost:6380",
  ENCRYPTION_KEY: "dev-only-insecure-encryption-key-do-not-use-in-prod",
  API_KEY_PEPPER: "dev-only-insecure-api-key-pepper-do-not-use-in-prod",
};
