import "dotenv/config";
import { createPool, getMigrationStatus, runMigrations, validateMigrations } from "../shared/db/index.js";
import { loadConfig, type AppConfig } from "../shared/config/index.js";
import { createLogger } from "../shared/logger/index.js";

// This is a terminal-facing CLI tool, not request/worker application code —
// `console.*` here is its actual output channel (status tables, exit
// messages), not a stray debug statement left behind. The shared logger is
// still used for structured operational logging inside the migration runner
// itself (applied/failed migration events).

const VALID_COMMANDS = ["up", "status", "validate"] as const;
type Command = (typeof VALID_COMMANDS)[number];

function parseCommand(argv: readonly string[]): Command {
  const [command] = argv;
  if (command && (VALID_COMMANDS as readonly string[]).includes(command)) {
    return command as Command;
  }
  console.error(`Usage: migrate <${VALID_COMMANDS.join("|")}>`);
  process.exit(1);
}

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    console.error("Invalid configuration:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const command = parseCommand(process.argv.slice(2));
const config = loadConfigOrExit();
const logger = createLogger({
  level: config.log.level,
  serviceName: config.service.name,
  env: config.env,
});
const pool = createPool(config.database, logger);

try {
  switch (command) {
    case "up": {
      const result = await runMigrations(pool, logger);
      if (result.applied.length === 0) {
        console.log("No pending migrations. Database is up to date.");
      } else {
        console.log(`Applied ${result.applied.length} migration(s):`);
        for (const filename of result.applied) {
          console.log(`  - ${filename}`);
        }
      }
      break;
    }
    case "status": {
      const entries = await getMigrationStatus(pool);
      if (entries.length === 0) {
        console.log("No migration files found.");
      } else {
        console.log("VERSION  STATUS       NAME");
        for (const entry of entries) {
          const status = entry.applied ? "applied" : "pending";
          console.log(`${String(entry.version).padStart(7, "0")}  ${status.padEnd(11)}  ${entry.name}`);
        }
      }
      break;
    }
    case "validate": {
      await validateMigrations(pool);
      console.log("All applied migrations match their recorded checksums.");
      break;
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => undefined);
}
