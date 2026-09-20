import { defineConfig } from "vite";

/**
 * Bundles the Node side (CLI + library entry) to plain ESM in `dist/`, so the
 * published package doesn't ship raw TypeScript and doesn't need `tsx` at runtime.
 * Runtime dependencies stay external — `sharp` and `playwright` have native/browser
 * payloads that must be resolved from node_modules, not inlined.
 */
export default defineConfig({
  build: {
    ssr: true,
    target: "node20",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: { cli: "src/cli.ts", index: "src/index.ts" },
      external: [/^node:/, "playwright", "sharp", "zod"],
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
