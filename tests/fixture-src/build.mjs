// Builds the Third Pour fixture: render every page into tests/fixture/, then compile
// Tailwind (scanning the generated HTML) into tests/fixture/assets/tailwind.css.
//
//   npm run fixture:build
//
// Output is committed so the static server / `npm run demo|demo:crawl|fixture` and the
// crawler need no build at serve time. crawl-map.input.json is hand-authored and left alone.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { page } from "./layout.mjs";
import { allPages } from "./pages.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const OUT = path.join(ROOT, "tests", "fixture");

async function main() {
  // Drop pages from the old fixture that the new structure replaces.
  for (const legacy of ["blog", "secret.html"]) {
    await fs.rm(path.join(OUT, legacy), { recursive: true, force: true });
  }

  await fs.mkdir(path.join(OUT, "articles"), { recursive: true });
  await fs.mkdir(path.join(OUT, "assets"), { recursive: true });

  const pages = allPages();
  for (const p of pages) {
    const dest = path.join(OUT, p.file);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, page(p) + "\n");
  }
  console.log(`✓ wrote ${pages.length} pages`);
  for (const p of pages) console.log(`  ${p.path.padEnd(34)} → tests/fixture/${p.file}`);

  // Compile Tailwind against the freshly written HTML.
  const bin = path.join(ROOT, "node_modules", ".bin", "tailwindcss");
  const args = [
    "-c",
    "tests/fixture-src/tailwind.config.js",
    "-i",
    "tests/fixture-src/tailwind.input.css",
    "-o",
    "tests/fixture/assets/tailwind.css",
    "--minify",
  ];
  console.log("\n› compiling tailwind…");
  const res = spawnSync(bin, args, { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`tailwindcss exited with code ${res.status}`);
  }
  console.log("✓ tests/fixture/assets/tailwind.css");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
