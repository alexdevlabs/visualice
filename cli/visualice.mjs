#!/usr/bin/env node
// Launcher: runs the built CLI when there is one (that's what an installed package
// ships), and falls back to `tsx` on the TypeScript sources in a dev checkout that
// hasn't been built. The built path must not need tsx — it's a devDependency.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = resolve(root, "dist/cli.js");
const src = resolve(root, "src");

/** Newest mtime under `src` — 0 when there are no sources (an installed package). */
function newestSource() {
  try {
    let newest = 0;
    for (const entry of readdirSync(src, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
    }
    return newest;
  } catch {
    return 0;
  }
}

// A checkout whose sources are newer than its build would otherwise silently run
// stale code, so there the sources win and tsx takes over.
const stale = existsSync(built) && newestSource() > statSync(built).mtimeMs;

if (existsSync(built) && !stale) {
  await import(pathToFileURL(built).href);
} else {
  const { spawn } = await import("node:child_process");
  const cli = resolve(root, "src/cli.ts");
  if (!existsSync(cli)) {
    console.error("visualice: no dist/cli.js and no src/cli.ts — the install is incomplete.");
    process.exit(1);
  }
  // `node <tsx's cli>` rather than `npx tsx`: Windows can't spawn npx without a shell.
  let tsx;
  try {
    tsx = createRequire(join(root, "package.json")).resolve("tsx/cli");
  } catch {
    console.error(
      "visualice: no dist/cli.js, and tsx isn't installed to run the sources — run 'npm install'.",
    );
    process.exit(1);
  }
  const child = spawn(process.execPath, [tsx, cli, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
  child.on("error", (err) => {
    console.error(`failed to launch: ${err.message}`);
    process.exit(1);
  });
  // A null code means the child was killed by a signal — surface that as failure
  // (exit 1) rather than masking it as success.
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
