import { defineConfig } from "vitest/config";

/**
 * Unit tests: fast, no browser. The browser-driven suites live in
 * `tests/integration/` and run via `npm run test:integration`.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
  },
});
