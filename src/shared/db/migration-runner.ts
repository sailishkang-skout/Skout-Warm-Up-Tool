import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { DatabaseError } from "../errors/index.js";
import type { Logger } from "../logger/index.js";
import { mapDatabaseError } from "./errors.js";

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationStatusEntry {
  readonly version: number;
  readonly name: string;
  readonly applied: boolean;
  readonly appliedAt?: Date;
}

export interface RunMigrationsResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

const MIGRATION_FILENAME_PATTERN = /^(\d+)_([a-z0-9_]+)\.sql$/;

const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

// Resolves to <repo-root>/migrations regardless of whether this module runs
// from src/ (tsx, dev) or dist/ (compiled) — both sit at the same depth
// under the repo root.
const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

export function parseMigrationFilename(filename: string): { version: number; name: string } | undefined {
  const match = MIGRATION_FILENAME_PATTERN.exec(filename);
  if (!match) {
    return undefined;
  }
  const [, versionText, name] = match;
  return { version: Number(versionText), name: name! };
}

export function computeChecksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/** Refuses to guess which file "wins" on a version collision — that's a repo bug to fix by renumbering. */
export function assertNoDuplicateVersions(files: readonly MigrationFile[]): void {
  const seenBy = new Map<number, string>();
  for (const file of files) {
    const existing = seenBy.get(file.version);
    if (existing) {
      throw new DatabaseError(
        `Duplicate migration version ${file.version}: '${existing}' and '${file.filename}'`,
      );
    }
    seenBy.set(file.version, file.filename);
  }
}

export function sortMigrations(files: readonly MigrationFile[]): MigrationFile[] {
  return [...files].sort((a, b) => a.version - b.version);
}

export async function loadMigrationFiles(migrationsDir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  const files: MigrationFile[] = [];

  for (const filename of entries) {
    if (!filename.endsWith(".sql")) {
      continue;
    }
    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      throw new DatabaseError(
        `Migration file '${filename}' does not match the required 'NNN_name.sql' naming convention`,
      );
    }
    const sql = await readFile(path.join(migrationsDir, filename), "utf8");
    files.push({
      version: parsed.version,
      name: parsed.name,
      filename,
      checksum: computeChecksum(sql),
      sql,
    });
  }

  assertNoDuplicateVersions(files);
  return sortMigrations(files);
}

async function ensureMigrationsTable(pool: Pool): Promise<void> {
  try {
    await pool.query(MIGRATIONS_TABLE_DDL);
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

interface SchemaMigrationRow {
  version: number;
  name: string;
  checksum: string;
  applied_at: Date;
}

async function fetchAppliedMigrations(pool: Pool): Promise<Map<number, MigrationRecord>> {
  try {
    const result = await pool.query<SchemaMigrationRow>(
      "SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version",
    );
    const applied = new Map<number, MigrationRecord>();
    for (const row of result.rows) {
      applied.set(row.version, {
        version: row.version,
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
      });
    }
    return applied;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

/**
 * Fails loudly rather than silently re-running or skipping: if a migration
 * already recorded as applied no longer matches the file on disk, the
 * history the tracking table represents can no longer be trusted, and
 * proceeding could silently diverge dev/staging/production schemas.
 */
function assertChecksumsMatch(
  files: readonly MigrationFile[],
  applied: ReadonlyMap<number, MigrationRecord>,
): void {
  for (const file of files) {
    const record = applied.get(file.version);
    if (record && record.checksum !== file.checksum) {
      throw new DatabaseError(
        `Migration ${file.filename} has changed since it was applied on ` +
          `${record.appliedAt.toISOString()} (checksum mismatch). Do not edit an ` +
          `already-applied migration — add a new one instead.`,
      );
    }
  }
}

export async function getMigrationStatus(pool: Pool, migrationsDir?: string): Promise<MigrationStatusEntry[]> {
  await ensureMigrationsTable(pool);
  const files = await loadMigrationFiles(migrationsDir);
  const applied = await fetchAppliedMigrations(pool);
  assertChecksumsMatch(files, applied);

  return files.map((file) => {
    const record = applied.get(file.version);
    return {
      version: file.version,
      name: file.name,
      applied: record !== undefined,
      ...(record ? { appliedAt: record.appliedAt } : {}),
    };
  });
}

export async function validateMigrations(pool: Pool, migrationsDir?: string): Promise<void> {
  await ensureMigrationsTable(pool);
  const files = await loadMigrationFiles(migrationsDir);
  const applied = await fetchAppliedMigrations(pool);
  assertChecksumsMatch(files, applied);
}

/** Safe to run repeatedly: already-applied migrations are skipped, not re-run. */
export async function runMigrations(
  pool: Pool,
  logger: Logger,
  migrationsDir?: string,
): Promise<RunMigrationsResult> {
  await ensureMigrationsTable(pool);
  const files = await loadMigrationFiles(migrationsDir);
  const applied = await fetchAppliedMigrations(pool);
  assertChecksumsMatch(files, applied);

  const appliedNow: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file.version)) {
      alreadyApplied.push(file.filename);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(file.sql);
      await client.query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [
        file.version,
        file.name,
        file.checksum,
      ]);
      await client.query("COMMIT");
      appliedNow.push(file.filename);
      logger.info({ migration: file.filename }, "Applied migration");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const mapped = mapDatabaseError(error);
      logger.error({ err: mapped, migration: file.filename }, "Migration failed");
      throw mapped;
    } finally {
      client.release();
    }
  }

  return { applied: appliedNow, alreadyApplied };
}
