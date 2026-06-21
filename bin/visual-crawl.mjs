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
child.on("exit", (code) => process.exit(code ?? 0));
