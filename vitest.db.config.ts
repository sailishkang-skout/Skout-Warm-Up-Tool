import { defineConfig } from "vitest/config";

// Requires a live PostgreSQL reachable at TEST_DATABASE_URL. Bring one up
// with `docker compose up -d postgres` (see docker-compose.yml), then run
// `npm run test:db`. Never mocks SQL/migration behavior — this is what
// actually exercises real Postgres constraints, transactions, and the
// migration runner against a real database.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Every file in this suite shares one physical test database and some
    // of them (migrations.test.ts) destructively DROP/recreate schema —
    // running files in parallel races schema mutations against each other
    // (a dropped function used by another file's in-flight migration, etc).
    fileParallelism: false,
    maxWorkers: 1,
    pool: "forks",
  },
});
