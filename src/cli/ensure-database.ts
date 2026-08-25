/**
 * One-off bootstrap: connect to the shared RDS default database (`skout` or
 * whatever DATABASE_NAME is overridden to) and CREATE DATABASE email_warmup
 * if it does not already exist. Used by ECS run-task before migrations.
 */
import "dotenv/config";
import pg from "pg";

const TARGET_DB = process.env.TARGET_DATABASE_NAME ?? "email_warmup";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

function buildAdminUrl(): string {
  if (process.env.DATABASE_URL?.trim()) {
    // Point at the default/admin database, not the target (which may not exist).
    // Strip sslmode from the URL — SSL is configured via the Client `ssl` option
    // so Node accepts Amazon RDS's certificate chain.
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = `/${process.env.ADMIN_DATABASE_NAME ?? "skout"}`;
    url.searchParams.delete("sslmode");
    return url.toString();
  }

  const host = requireEnv("DATABASE_HOST");
  const port = process.env.DATABASE_PORT ?? "5432";
  const user = process.env.DATABASE_USER ?? "skout";
  const password = requireEnv("DATABASE_PASSWORD");
  const adminDb = process.env.ADMIN_DATABASE_NAME ?? process.env.DATABASE_NAME ?? "skout";
  const enc = encodeURIComponent(password);
  return `postgresql://${user}:${enc}@${host}:${port}/${adminDb}`;
}

const adminUrl = buildAdminUrl();
const useSsl = (process.env.DATABASE_SSL ?? "true") === "true";
const client = new pg.Client({
  connectionString: adminUrl,
  // RDS uses Amazon's CA; rejectUnauthorized:false matches Skout API behavior.
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

try {
  await client.connect();
  const existing = await client.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [TARGET_DB],
  );
  if (existing.rows[0]?.exists) {
    console.log(`Database ${TARGET_DB} already exists`);
  } else {
    // Identifier cannot be parameterized; TARGET_DB is fixed/env-controlled.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(TARGET_DB)) {
      throw new Error(`Refusing unsafe TARGET_DATABASE_NAME: ${TARGET_DB}`);
    }
    await client.query(`CREATE DATABASE ${TARGET_DB}`);
    console.log(`Created database ${TARGET_DB}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
