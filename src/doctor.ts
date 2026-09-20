import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { satisfies } from "./shared/version";
import { pathExists } from "./shared/fsx";

/**
 * Preflight: everything that has to be true before a crawl can work, checked in
 * one idempotent pass that repairs what it safely can. This is what keeps a
 * skill's first run from dying on a cryptic Playwright error.
 */

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Set when this run repaired the problem. */
  fixed?: boolean;
  /** What the user should do, when we couldn't do it for them. */
  hint?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  /** Install root — where package.json, viewer/dist and (in a checkout) src live. */
  projectRoot: string;
  /** Attempt repairs (default true). */
  fix?: boolean;
  log?: (msg: string) => void;
  /** Injection seam for tests. */
  nodeVersion?: string;
}

/** Run a command to completion, resolving to its exit code (127 if it never started). */
function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function readEnginesNode(projectRoot: string): Promise<string | undefined> {
  const raw = await fs.readFile(path.join(projectRoot, "package.json"), "utf8").catch(() => "");
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as { engines?: { node?: string } }).engines?.node;
  } catch {
    return undefined;
  }
}

async function checkNode(opts: DoctorOptions): Promise<DoctorCheck> {
  const current = opts.nodeVersion ?? process.version;
  const range = (await readEnginesNode(opts.projectRoot)) ?? ">=20.12.0";
  const ok = satisfies(current, range);
  return {
    name: "node",
    ok,
    detail: ok ? `${current} (needs ${range})` : `${current} is too old — needs ${range}`,
    hint: ok ? undefined : `upgrade Node to ${range}`,
  };
}

/** Playwright's chromium: resolvable module + a downloaded browser binary. */
async function checkChromium(opts: DoctorOptions): Promise<DoctorCheck> {
  let executablePath: string;
  try {
    const { chromium } = await import("playwright");
    executablePath = chromium.executablePath();
  } catch (e) {
    return {
      name: "chromium",
      ok: false,
      detail: `playwright is not usable: ${(e as Error).message.split("\n")[0]}`,
      hint: "npm install",
    };
  }

  if (existsSync(executablePath)) {
    return { name: "chromium", ok: true, detail: executablePath };
  }
  if (opts.fix === false) {
    return {
      name: "chromium",
      ok: false,
      detail: "browser not installed",
      hint: "npx playwright install chromium",
    };
  }

  opts.log?.("installing chromium (one-time, ~100MB)…");
  const code = await run("npx", ["playwright", "install", "chromium"], opts.projectRoot);
  const nowThere = existsSync(executablePath) || code === 0;
  return {
    name: "chromium",
    ok: nowThere,
    fixed: nowThere,
    detail: nowThere ? "installed just now" : `install failed (exit ${code})`,
    hint: nowThere ? undefined : "npx playwright install chromium",
  };
}

/** sharp ships a platform-specific native binary — a wrong one only fails at use time. */
async function checkSharp(): Promise<DoctorCheck> {
  try {
    const sharp = (await import("sharp")).default;
    // Encode a 1×1 image: proves the native binding actually loaded and runs.
    await sharp({ create: { width: 1, height: 1, channels: 3, background: "#000" } })
      .png()
      .toBuffer();
    return { name: "sharp", ok: true, detail: "native image pipeline works" };
  } catch (e) {
    return {
      name: "sharp",
      ok: false,
      detail: (e as Error).message.split("\n")[0],
      hint: "npm rebuild sharp (or reinstall for this platform)",
    };
  }
}

/** The viewer is a prebuilt static app; a source checkout can build it on demand. */
async function checkViewer(opts: DoctorOptions): Promise<DoctorCheck> {
  const dist = path.join(opts.projectRoot, "viewer", "dist", "index.html");
  if (await pathExists(dist)) return { name: "viewer", ok: true, detail: path.dirname(dist) };

  const hasSource = await pathExists(path.join(opts.projectRoot, "viewer", "index.html"));
  if (!hasSource) {
    return {
      name: "viewer",
      ok: false,
      detail: "viewer/dist is missing and there are no sources to build it from",
      hint: "reinstall visualice",
    };
  }
  if (opts.fix === false) {
    return { name: "viewer", ok: false, detail: "not built", hint: "npm run viewer:build" };
  }

  opts.log?.("building the viewer…");
  const code = await run("npx", ["vite", "build", "viewer"], opts.projectRoot);
  const built = await pathExists(dist);
  return {
    name: "viewer",
    ok: built,
    fixed: built,
    detail: built ? "built just now" : `build failed (exit ${code})`,
    hint: built ? undefined : "npm run viewer:build",
  };
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [await checkNode(opts)];
  // Sequential on purpose: the fixes shell out and stream to the terminal, and
  // interleaved progress bars from two installers are unreadable.
  checks.push(await checkChromium(opts));
  checks.push(await checkSharp());
  checks.push(await checkViewer(opts));
  return { ok: checks.every((c) => c.ok), checks };
}

/** Human-readable lines for the CLI. */
export function formatDoctor(result: DoctorResult): string[] {
  const lines = result.checks.map((c) => {
    const mark = c.ok ? (c.fixed ? "✚" : "✓") : "✗";
    const hint = c.hint ? `  → ${c.hint}` : "";
    return `${mark} ${c.name.padEnd(9)} ${c.detail}${hint}`;
  });
  lines.push(result.ok ? "all good — visualice is ready" : "not ready — see the ✗ lines above");
  return lines;
}
