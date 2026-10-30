import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const require = createRequire(import.meta.url);

/**
 * The bundled fonts are OFL-licensed, and the OFL asks for its text to travel with
 * the font files: emit each package's LICENSE next to the build's assets.
 */
function fontLicenses(pkgs: string[]): Plugin {
  return {
    name: "font-licenses",
    apply: "build",
    generateBundle() {
      for (const pkg of pkgs) {
        const file = require.resolve(`${pkg}/LICENSE`);
        this.emitFile({
          type: "asset",
          fileName: `licenses/${pkg.split("/").pop()}-OFL.txt`,
          source: readFileSync(file, "utf8"),
        });
      }
    },
  };
}

// `base: "./"` keeps asset URLs relative so the build works under any mount point.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    fontLicenses(["@fontsource/figtree", "@fontsource/ibm-plex-mono"]),
  ],
  build: { outDir: "dist", emptyOutDir: true },
});
