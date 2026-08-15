import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig, type AppConfig } from "./shared/config/index.js";
import { createLogger } from "./shared/logger/index.js";

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    // The full typed logger needs a validated config to build, so a config
    // failure is reported through a minimal bootstrap logger instead — it
    // must never echo raw process.env values, only the sanitized error
    // message `loadConfig` already produced.
    const bootstrapLogger = createLogger({
      level: "info",
      serviceName: process.env.SERVICE_NAME ?? "skout-email-warmup-service",
      env: process.env.NODE_ENV ?? "development",
    });
    bootstrapLogger.error({ err: error }, "Invalid configuration - refusing to start");
    process.exit(1);
  }
}

const config = loadConfigOrExit();
const app = await buildApp(config);

try {
  await app.listen({
    port: config.http.port,
    host: "0.0.0.0",
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
