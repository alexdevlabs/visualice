#!/usr/bin/env node
// Thin launcher: runs the TypeScript CLI via tsx (no build step needed in dev).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "src/cli.ts");

const child = spawn("npx", ["tsx", cli, ...process.argv.slice(2)], {
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
