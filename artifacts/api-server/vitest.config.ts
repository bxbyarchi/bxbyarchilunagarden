import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Set before any test file (and therefore app.ts / lib/db) is imported —
    // a real DB connection is never opened by these tests, but lib/db throws
    // at import time if DATABASE_URL is unset, and Clerk's verifyToken() call
    // needs a (fake, here) CLERK_SECRET_KEY to exist so it can run and fail
    // closed rather than throw.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test_unused",
      // Fake, well-formed publishable key (not tied to any real Clerk instance).
      // The Clerk SDK validates its *shape* at middleware-init time even when
      // no request ever uses it, so a well-formed value is needed here just to
      // let clerkMiddleware() initialize — these tests never authenticate.
      CLERK_PUBLISHABLE_KEY: "pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk",
      CLERK_SECRET_KEY: "sk_test_unused_in_these_tests",
    },
  },
});
