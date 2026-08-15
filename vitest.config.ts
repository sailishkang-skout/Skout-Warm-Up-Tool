import { defineConfig } from "vitest/config";

// tests/db/** is deliberately excluded here — it requires a live Postgres
// (npm run test:db, its own config), and must never make plain `npm test`
// hang or fail in an environment without Docker/Postgres running.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    restoreMocks: true,
  },
});
