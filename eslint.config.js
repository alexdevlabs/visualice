// ESLint 9 flat config. Scope: correctness only — Prettier owns formatting
// (eslint-config-prettier is applied last to disable any stylistic rules).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // Not source: build output, deps, runtime crawl output, HTML fixtures
    // (and the fixture authoring sources — HTML-in-template-literals).
    ignores: [
      "**/dist/**",
      "node_modules/**",
      "coverage/**",
      ".visualice/**",
      "tests/fixture/**",
      "tests/fixture-src/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    // TypeScript already resolves globals via its `lib` (DOM in page.evaluate
    // callbacks, Node elsewhere), so the core no-undef rule is redundant and
    // produces false positives — disable it as typescript-eslint recommends.
    // Allow intentionally-unused identifiers when prefixed with `_`.
    rules: {
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },

  {
    // Node-side engine, CLI, tests, and root tool configs.
    files: ["src/**/*.ts", "tests/**/*.ts", "bin/**/*.mjs", "*.ts", "*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // Viewer: React running in the browser.
    files: ["viewer/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...reactHooks.configs.recommended.rules },
  },

  prettier,
);
