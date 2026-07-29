import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { loadConfig, type Config } from "./shared/config";
import { COMMAND_FLAGS, UsageError, applyOverrides, parseFlags, str, type Flags } from "./cli-args";
import { loadInputManifest, saveJson } from "./crawl/manifest";
import { InputManifestSchema, formatManifestIssues } from "./shared/manifest-schema";
import { capturePipeline, crawlPipeline } from "./crawl/orchestrator";
import { discoverPipeline } from "./crawl/discover";
import { ensureStorageState } from "./crawl/auth";
import { pathExists } from "./shared/fsx";
import { serveDirectory } from "./shared/static-server";
import { serveViewer } from "./serve";
import type { Manifest } from "./shared/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(PROJECT_ROOT, "tests", "fixture");

async function loadConfigWithOverrides(flags: Flags): Promise<Config> {
  return applyOverrides(await loadConfig(str(flags, "config")), flags);
}

type Log = (msg: string) => void;
const makeLog = (flags: Flags): Log => (flags.quiet === true ? () => {} : (m) => console.error(m));

function printHelp(): void {
  console.log(`visualice — crawl a site and capture pages + UI states across devices

Usage:
  visualice crawl [opts]      Discover routes + UI states, then capture across devices
  visualice discover [opts]   Auto-discover routes + UI states (no screenshots)
  visualice validate [opts]   Validate a crawl manifest / cached site model
  visualice auth [--force]    Run the configured login recipe → save storage state
  visualice capture [opts]    Replay a given manifest's recipes and capture screenshots
  visualice demo              Capture the bundled fixture from a hand-written manifest
  visualice demo-crawl        Full discover→capture run against the bundled fixture
  visualice fixture [opts]    Serve the bundled fixture blog so you can browse it
  visualice serve [opts]      Launch the zoomable results viewer
  visualice --version         Print the version

Options (flags accept --name=value or --name value):
  --config=<path>      config file (.ts/.js/.json); defaults applied if omitted
  --base=<url>         base URL (overrides config.target)
  --manifest=<path>    input manifest for 'capture' / 'validate'
  --replay             for 'crawl': reuse cached site model, skip discovery
  --json               print a machine-readable JSON summary to stdout
  --quiet              suppress progress output on stderr
  --fail-on-error      exit 3 if any capture failed
  --max-pages=<n>      override scope.maxPages
  --include=<globs>    override scope.include (comma-separated)
  --exclude=<globs>    override scope.exclude (comma-separated)
  --devices=<names>    capture only these configured devices (comma-separated)
  --concurrency=<n>    override politeness.concurrency
  --timeout=<ms>       override politeness.timeoutMs
  --out=<dir>          override output.dir (default .visualice)
  --run=<id>           for 'serve': which run to view (default: latest)
  --port=<n>           for 'serve'/'fixture': fixed port (default: random)
  --open               for 'serve'/'fixture': open in your browser
  --shoot=<file>       for 'serve': headless-screenshot the viewer to a file, then exit

Exit codes: 0 ok · 1 error · 2 usage · 3 capture failures (with --fail-on-error)

Output lands under <config.output.dir>/runs/<runId>/ (default .visualice/).`);
}

/** Print the end-of-run summary; JSON on stdout when asked, human lines otherwise. */
function reportDone(runDir: string, manifest: Manifest, flags: Flags, log: Log): void {
  const stats = manifest.stats;
  if (flags.json === true) {
    console.log(
      JSON.stringify({
        runId: manifest.site.runId,
        runDir,
        manifest: path.join(runDir, "crawl-map.json"),
        report: path.join(runDir, "crawl-report.md"),
        routes: stats?.routes ?? 0,
        states: stats?.states ?? 0,
        shots: stats?.shots ?? 0,
        failed: stats?.failed ?? 0,
        failures: stats?.failures ?? [],
      }),
    );
  } else {
    log("");
    log(
      `done — ${stats?.shots ?? 0} screenshots${stats?.failed ? `, ${stats.failed} FAILED` : ""}`,
    );
    console.log(runDir);
    log(`  manifest : ${path.join(runDir, "crawl-map.json")}`);
    log(`  report   : ${path.join(runDir, "crawl-report.md")}`);
  }
  if (flags["fail-on-error"] === true && (stats?.failed ?? 0) > 0) {
    log(`${stats!.failed} capture(s) failed — exiting 3 (--fail-on-error)`);
    process.exitCode = 3;
  }
}

async function cmdCapture(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const manifestPath = str(flags, "manifest");
  if (!manifestPath) throw new UsageError("capture requires --manifest=<path>");
  const baseUrl = str(flags, "base") ?? config.target;
  if (!baseUrl) throw new UsageError("no base URL: pass --base=<url> or set target in config");

  const inputManifest = await loadInputManifest(manifestPath);
  const { runDir, manifest } = await capturePipeline({ config, inputManifest, baseUrl, log });
  reportDone(runDir, manifest, flags, log);
}

async function cmdValidate(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const file =
    str(flags, "manifest") ?? path.join(path.resolve(config.output.dir), "crawl-map.cache.json");
  if (!(await pathExists(file))) {
    throw new UsageError(`no manifest at ${file} — pass --manifest=<path> or run a discover first`);
  }

  let raw: unknown;
  let issues: string[];
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
    const result = InputManifestSchema.safeParse(raw);
    issues = result.success ? [] : formatManifestIssues(result.error);
  } catch (e) {
    issues = [`not valid JSON: ${(e as Error).message}`];
  }

  const parsed = issues.length ? undefined : InputManifestSchema.parse(raw);
  const routes = parsed?.routes.length ?? 0;
  const states = parsed?.routes.reduce((n, r) => n + r.states.length, 0) ?? 0;

  if (flags.json === true) {
    console.log(JSON.stringify({ file, valid: issues.length === 0, issues, routes, states }));
  } else if (issues.length) {
    log(`✗ ${file} is INVALID:`);
    for (const issue of issues) log(`  - ${issue}`);
  } else {
    log(`✓ ${file} is valid — ${routes} route(s), ${states} state(s)`);
    console.log(file);
  }
  if (issues.length) process.exitCode = 1;
}

async function ensureViewerBuilt(viewerDist: string, log: Log): Promise<void> {
  if (await pathExists(path.join(viewerDist, "index.html"))) return;
  log("building viewer (first run)…");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["vite", "build", "viewer"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`vite build failed (${code})`)),
    );
  });
}

async function shootViewer(url: string, outFile: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1000 },
      deviceScaleFactor: 2,
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.screenshot({ path: outFile });
  } finally {
    await browser.close();
  }
}

/** Parse and validate an optional --port flag. */
function parsePort(flags: Flags): number | undefined {
  const v = str(flags, "port");
  if (v === undefined) return undefined;
  const port = Number(v);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`invalid --port=${v}`);
  }
  return port;
}

/** Open a URL in the default browser, cross-platform, without holding the process. */
function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
}

/** Resolve when the user interrupts (Ctrl-C) or the process is asked to terminate. */
function untilInterrupted(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
  });
}

async function cmdServe(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const outRoot = path.resolve(config.output.dir);
  const runId = str(flags, "run") ?? "latest";
  const runDir = path.join(outRoot, "runs", runId);
  if (!(await pathExists(path.join(runDir, "viewer-data.json")))) {
    throw new Error(
      `no run data at ${runDir}/viewer-data.json — run a crawl first (e.g. 'visualice crawl').`,
    );
  }

  const viewerDist = path.join(PROJECT_ROOT, "viewer", "dist");
  await ensureViewerBuilt(viewerDist, log);

  const server = await serveViewer({ runDir, viewerDist, port: parsePort(flags) });

  const shoot = str(flags, "shoot");
  if (shoot !== undefined) {
    await shootViewer(server.url, shoot);
    await server.close();
    log(`wrote ${shoot}`);
    return;
  }

  log(`viewer serving run '${runId}' at:`);
  console.log(server.url);
  if (flags.open === true) openInBrowser(server.url);
  log("press Ctrl-C to stop.");
  await untilInterrupted();
  await server.close();
}

async function cmdCrawl(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const baseUrl = str(flags, "base") ?? config.target;
  if (!baseUrl) throw new UsageError("no base URL: pass --base=<url> or set target in config");
  const { runDir, manifest } = await crawlPipeline({
    config,
    baseUrl,
    replay: flags.replay === true,
    log,
  });
  reportDone(runDir, manifest, flags, log);
}

async function cmdAuth(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfig(str(flags, "config"));
  if (!config.auth.storageStatePath) {
    throw new Error("config.auth.storageStatePath is not set — nothing to authenticate.");
  }
  if (flags.force === true) {
    await fs.rm(path.resolve(config.auth.storageStatePath), { force: true }).catch(() => {});
  }
  const sp = await ensureStorageState(config, log);
  log(sp ? `auth ready: ${sp}` : "no login recipe configured; nothing to do.");
}

async function cmdDiscover(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const baseUrl = str(flags, "base") ?? config.target;
  if (!baseUrl) throw new UsageError("no base URL: pass --base=<url> or set target in config");
  const inputManifest = await discoverPipeline({ config, baseUrl, log });
  const cachePath = path.join(path.resolve(config.output.dir), "crawl-map.cache.json");
  await saveJson(cachePath, inputManifest);
  const states = inputManifest.routes.reduce((n, r) => n + r.states.length, 0);
  if (flags.json === true) {
    console.log(JSON.stringify({ cachePath, routes: inputManifest.routes.length, states }));
  } else {
    log("");
    log(`discovered ${inputManifest.routes.length} routes, ${states} states`);
    console.log(cachePath);
  }
}

async function cmdDemoCrawl(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const server = await serveDirectory(FIXTURE_DIR);
  log(`fixture served at ${server.url}`);
  try {
    const config = await loadConfig(str(flags, "config"));
    const { runDir, manifest } = await crawlPipeline({
      config,
      baseUrl: server.url,
      replay: flags.replay === true,
      log,
    });
    reportDone(runDir, manifest, flags, log);
  } finally {
    await server.close();
  }
}

async function cmdFixture(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const server = await serveDirectory(FIXTURE_DIR, { port: parsePort(flags) });
  log("fixture blog serving at:");
  console.log(server.url);
  if (flags.open === true) openInBrowser(server.url);
  log("press Ctrl-C to stop.");
  await untilInterrupted();
  await server.close();
}

async function cmdDemo(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const server = await serveDirectory(FIXTURE_DIR);
  log(`fixture served at ${server.url}`);
  try {
    const config = await loadConfig(str(flags, "config"));
    const inputManifest = await loadInputManifest(path.join(FIXTURE_DIR, "crawl-map.input.json"));
    const { runDir, manifest } = await capturePipeline({
      config,
      inputManifest,
      baseUrl: server.url,
      log,
    });
    reportDone(runDir, manifest, flags, log);
  } finally {
    await server.close();
  }
}

async function printVersion(): Promise<void> {
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  console.log(pkg.version);
}

/**
 * Load `.env` from the working directory if there is one, so auth recipes can
 * reference ${VC_USER}/${VC_PASS} without exporting them by hand. Real env vars
 * already set win — `loadEnvFile` never overwrites them.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile(path.resolve(".env"));
  } catch {
    /* no .env, or an unreadable one — env vars can still be exported directly */
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v") return printVersion();
  if (!(cmd in COMMAND_FLAGS)) {
    console.error(`unknown command: ${cmd}`);
    printHelp();
    process.exitCode = 2;
    return;
  }
  const flags = parseFlags(cmd, rest);
  switch (cmd) {
    case "crawl":
      return cmdCrawl(flags);
    case "discover":
      return cmdDiscover(flags);
    case "validate":
      return cmdValidate(flags);
    case "auth":
      return cmdAuth(flags);
    case "demo":
      return cmdDemo(flags);
    case "demo-crawl":
      return cmdDemoCrawl(flags);
    case "fixture":
      return cmdFixture(flags);
    case "capture":
      return cmdCapture(flags);
    case "serve":
      return cmdServe(flags);
  }
}

main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(e.message);
    process.exit(2);
  }
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
