import { defineConfig } from "vitest/config";

/**
 * Unit tests: fast, no browser. The browser-driven suites live in
 * `tests/integration/` and run via `npm run test:integration`.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      // `text` for the CI log, `html` for the uploaded artifact, `lcov` for
      // anything that later wants to read it (a badge, a PR annotation).
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      // Report on everything shippable, including files no test touches — a module
      // with no tests at all is the one coverage most needs to point at, and it is
      // invisible unless uncovered files are included.
      all: true,
      include: ["src/**/*.ts", "viewer/src/**/*.{ts,tsx}"],
      exclude: [
        // Entry points and generated output: either browser-mounting glue with no
        // logic to cover, or not source at all.
        "src/index.ts",
        "viewer/src/main.tsx",
        "**/*.d.ts",
        "dist/**",
        "viewer/dist/**",
      ],
    },
  },
});
