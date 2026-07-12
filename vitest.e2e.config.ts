import { defineConfig } from "vitest/config";
import { config as dotenv } from "dotenv";

// Live-tenant battle tests. Credentials come from .env.e2e (gitignored) or the
// environment; suites skip themselves when E2E_* is absent.
dotenv({ path: ".env.e2e" });

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["tests/e2e/**/*.e2e.ts"],
    // Live API round-trips — generous timeouts, and no parallel files so the
    // suites can't race each other on shared tenant fixtures.
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
