import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Run a dependency's command-line tool without `npx`.
 *
 * `spawn("npx", …)` doesn't work on Windows: the command there is `npx.cmd`, and Node
 * refuses to spawn a `.cmd` without a shell, which would then re-parse every argument.
 * Every tool we call (playwright, vite, tsx) is a Node script, so the portable way is
 * `node <its bin script>`, found through the package's own `package.json`.
 */

/** The script behind `pkg`'s `bin` (its first, or the one named `name`), resolved from `fromDir`. */
export function packageBin(pkg: string, fromDir: string, name = pkg): string | undefined {
  try {
    const require = createRequire(path.join(fromDir, "package.json"));
    const manifest = require.resolve(`${pkg}/package.json`);
    const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof bin === "string" ? bin : (bin?.[name] ?? Object.values(bin ?? {})[0]);
    return rel ? path.join(path.dirname(manifest), rel) : undefined;
  } catch {
    return undefined;
  }
}

/** `[command, args]` for spawn: `node <bin> …args`, or undefined if `pkg` isn't installed. */
export function nodeBinCommand(
  pkg: string,
  args: string[],
  fromDir: string,
): [string, string[]] | undefined {
  const bin = packageBin(pkg, fromDir);
  return bin ? [process.execPath, [bin, ...args]] : undefined;
}
