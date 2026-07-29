import { defineConfig } from "vitest/config";

/**
 * Integration tests: drive a real Chromium against a locally served fixture.
 * Slow, so they are kept out of the default `npm test` run and executed one
 * file at a time (each file owns a browser).
 *
 * Requires `npx playwright install chromium`.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
