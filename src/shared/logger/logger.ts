import pino, { type Logger as PinoLogger, type LoggerOptions } from "pino";
import { serializeError } from "../errors/index.js";
import type { LogLevelName } from "../config/index.js";

export type Logger = PinoLogger;

export interface LogContext {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly tenantId?: string;
  readonly mailboxId?: string;
  readonly jobId?: string;
  readonly workerId?: string;
}

export interface CreateLoggerOptions {
  readonly level: LogLevelName;
  readonly serviceName: string;
  readonly env: string;
}

/**
 * Path-based safety net for the one place a secret reliably ends up in a log
 * line by default: Fastify's own request logger echoing `req.headers`. Deep,
 * shape-agnostic redaction of application-logged objects is handled
 * separately by `sanitizeForLogging`, since fast-redact (pino's engine) only
 * matches paths it's told about in advance.
 */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.Authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  "*.password",
  "*.apiKey",
  "*.api_key",
  "*.apiKeyPepper",
  "*.accessToken",
  "*.access_token",
  "*.refreshToken",
  "*.refresh_token",
  "*.encryptionKey",
  "*.encryption_key",
  "*.smtpPassword",
  "*.authorization",
  "*.credentials",
  "*.secret",
  "*.rawKey",
];

/**
 * `destination` is exposed mainly for tests — a synchronous in-memory
 * `{ write(msg) }` sink removes the timing flakiness of asserting on a real
 * stream's output. Production call sites omit it and get pino's default
 * (stdout).
 */
export function createLogger(
  options: CreateLoggerOptions,
  destination?: pino.DestinationStream,
): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level,
    base: { service: options.serviceName, env: options.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers: { err: serializeError },
  };
  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}

export function childLogger(logger: Logger, context: LogContext): Logger {
  return logger.child(context);
}
