import { describe, expect, it } from "vitest";
import {
  assertNoDuplicateVersions,
  computeChecksum,
  parseMigrationFilename,
  sortMigrations,
  type MigrationFile,
} from "../../src/shared/db/index.js";
import { DatabaseError } from "../../src/shared/errors/index.js";

function makeFile(version: number, filename: string, sql = "SELECT 1;"): MigrationFile {
  return { version, name: filename.replace(/^\d+_/, "").replace(/\.sql$/, ""), filename, checksum: computeChecksum(sql), sql };
}

describe("parseMigrationFilename", () => {
  it("parses a well-formed 'NNN_name.sql' filename", () => {
    expect(parseMigrationFilename("001_create_tenants.sql")).toEqual({ version: 1, name: "create_tenants" });
    expect(parseMigrationFilename("042_add_mailbox_status_index.sql")).toEqual({
      version: 42,
      name: "add_mailbox_status_index",
    });
  });

  it("does not require zero-padding to exactly 3 digits", () => {
    expect(parseMigrationFilename("7_seed.sql")).toEqual({ version: 7, name: "seed" });
    expect(parseMigrationFilename("00123_big.sql")).toEqual({ version: 123, name: "big" });
  });

  it("rejects filenames that don't match the convention", () => {
    expect(parseMigrationFilename("create_tenants.sql")).toBeUndefined();
    expect(parseMigrationFilename("001-create-tenants.sql")).toBeUndefined();
    expect(parseMigrationFilename("001_Create_Tenants.sql")).toBeUndefined();
    expect(parseMigrationFilename("001_create_tenants.SQL")).toBeUndefined();
    expect(parseMigrationFilename(".gitkeep")).toBeUndefined();
    expect(parseMigrationFilename("README.md")).toBeUndefined();
  });
});

describe("computeChecksum", () => {
  it("is deterministic for identical content", () => {
    expect(computeChecksum("CREATE TABLE foo ();")).toBe(computeChecksum("CREATE TABLE foo ();"));
  });

  it("changes when the content changes by even one character", () => {
    expect(computeChecksum("CREATE TABLE foo ();")).not.toBe(computeChecksum("CREATE TABLE foo  ();"));
  });

  it("produces a sha256 hex digest", () => {
    expect(computeChecksum("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sortMigrations", () => {
  it("orders migrations by version ascending regardless of input order", () => {
    const files = [makeFile(3, "003_c.sql"), makeFile(1, "001_a.sql"), makeFile(2, "002_b.sql")];
    expect(sortMigrations(files).map((f) => f.version)).toEqual([1, 2, 3]);
  });

  it("does not mutate the input array", () => {
    const files = [makeFile(2, "002_b.sql"), makeFile(1, "001_a.sql")];
    const originalOrder = files.map((f) => f.version);
    sortMigrations(files);
    expect(files.map((f) => f.version)).toEqual(originalOrder);
  });
});

describe("assertNoDuplicateVersions", () => {
  it("does not throw when all versions are unique", () => {
    expect(() =>
      assertNoDuplicateVersions([makeFile(1, "001_a.sql"), makeFile(2, "002_b.sql")]),
    ).not.toThrow();
  });

  it("throws a DatabaseError naming both files when a version collides", () => {
    const files = [makeFile(1, "001_a.sql"), makeFile(1, "001_a_renamed.sql")];
    expect(() => assertNoDuplicateVersions(files)).toThrow(DatabaseError);
    expect(() => assertNoDuplicateVersions(files)).toThrow(/001_a\.sql/);
    expect(() => assertNoDuplicateVersions(files)).toThrow(/001_a_renamed\.sql/);
  });
});
