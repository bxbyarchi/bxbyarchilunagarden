import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Set before any test file (and therefore app.ts / lib/db) is imported —
    // a real DB connection is never opened by these tests, but lib/db throws
    // at import time if DATABASE_URL is unset.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test_unused",
    },
  },
});
