import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { loadConfig, type Config } from "./shared/config";
import { isCommand, UsageError, applyOverrides, parseFlags, str, type Flags } from "./cli-args";
import { countStates, loadInputManifest, modelCachePath, saveJson } from "./crawl/manifest";
import { InputManifestSchema, formatManifestIssues } from "./shared/manifest-schema";
import { capturePipeline, crawlPipeline } from "./crawl/orchestrator";
import { discoverPipeline } from "./crawl/discover";
import {
  applyRoutesIntent,
  computeWanted,
  loadRoutesIntent,
  routesFilePath,
  writeRoutesFile,
} from "./crawl/routes-file";
import { ensureStorageState } from "./crawl/auth";
import { pathExists } from "./shared/fsx";
import { serveDirectory } from "./shared/static-server";
import { serveViewer } from "./serve";
import { formatDoctor, runDoctor } from "./doctor";
import { latestRunId, runDir } from "./crawl/runs";
import type { Manifest } from "./shared/types";
import { exportRun } from "./export";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(PROJECT_ROOT, "tests", "fixture");

/** Config files picked up automatically from the working directory. */
const CONFIG_CANDIDATES = [
  "visualice.config.ts",
  "visualice.config.mjs",
  "visualice.config.js",
  "visualice.config.json",
];

async function detectConfigFile(): Promise<string | undefined> {
  for (const c of CONFIG_CANDIDATES) if (await pathExists(path.resolve(c))) return c;
  return undefined;
}

/** Explicit --config wins; otherwise a visualice.config.* in the cwd is picked up. */
async function resolveConfigPath(flags: Flags): Promise<string | undefined> {
  return str(flags, "config") ?? (await detectConfigFile());
}

async function loadConfigWithOverrides(flags: Flags): Promise<Config> {
  return applyOverrides(await loadConfig(await resolveConfigPath(flags)), flags);
}

type Log = (msg: string) => void;
const makeLog = (flags: Flags): Log => (flags.quiet === true ? () => {} : (m) => console.error(m));

function printHelp(): void {
  console.log(`visualice — crawl a site and capture pages + UI states across devices

Usage:
  visualice init [url]        Scaffold visualice.config.json (+ .gitignore entry)
  visualice crawl [url]       Discover routes + UI states, then capture across devices
  visualice discover [url]    Auto-discover routes + UI states (no screenshots)
  visualice routes [opts]     Regenerate the routes file from the cached site model
  visualice validate [opts]   Validate a crawl manifest / cached site model
  visualice auth [--force]    Run the configured login recipe → save storage state
  visualice capture [opts]    Replay a given manifest's recipes and capture screenshots
  visualice demo              Capture the bundled fixture from a hand-written manifest
  visualice demo-crawl        Full discover→capture run against the bundled fixture
  visualice fixture [opts]    Serve the bundled fixture blog so you can browse it
  visualice doctor [--no-fix] Check Node/Playwright/viewer deps and self-heal
  visualice export <dir>      Write the viewer + a run as a static folder to share
  visualice serve [opts]      Launch the zoomable results viewer
  visualice --version         Print the version

Project files: visualice.config.json controls behavior; visualice.routes.md lists
pages + UI states and is regenerated after every crawl (edit it: 'skip:' excludes,
'[ ]' requests a state). A visualice.config.* in the cwd is picked up automatically.

Options (flags accept --name=value or --name value):
  --config=<path>      config file (.ts/.js/.json); cwd auto-detection if omitted
  --base=<url>         base URL (overrides config.target); also the bare [url] arg
  --no-save            for 'crawl': don't scaffold a config on first run
  --manifest=<path>    input manifest for 'capture' / 'validate'
  --replay             for 'crawl': reuse cached site model, skip discovery
  --resume             for 'crawl': continue the newest interrupted run
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
  --no-fix             for 'doctor': report problems without repairing them

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
        wanted: stats?.wanted ?? [],
        ...(stats?.accessibility ? { accessibility: stats.accessibility } : {}),
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
  const file = str(flags, "manifest") ?? modelCachePath(path.resolve(config.output.dir));
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
  const states = parsed ? countStates(parsed.routes) : 0;

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

/**
 * A published package ships `viewer/dist` prebuilt. In a source checkout it may be
 * missing, so build it once — but only when the sources are actually there; an
 * installed package with no dist is a broken install, not a build opportunity.
 */
async function ensureViewerBuilt(viewerDist: string, log: Log): Promise<void> {
  if (await pathExists(path.join(viewerDist, "index.html"))) return;
  if (!(await pathExists(path.join(PROJECT_ROOT, "viewer", "index.html")))) {
    throw new Error(
      `the viewer is missing from this install (${viewerDist}) — reinstall visualice, or run 'visualice doctor'`,
    );
  }
  log("building viewer (first run)…");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["vite", "build", "viewer"], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`vite build failed (${code})`)),
    );
  });
}

async function cmdDoctor(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const result = await runDoctor({
    projectRoot: PROJECT_ROOT,
    fix: flags["no-fix"] !== true,
    log,
  });
  if (flags.json === true) {
    console.log(JSON.stringify(result));
  } else {
    for (const line of formatDoctor(result)) console.log(line);
  }
  if (!result.ok) process.exitCode = 1;
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

/** The run a command should act on: `--run`, or the latest. */
async function resolveRun(outRoot: string, flags: Flags): Promise<{ id: string; dir: string }> {
  const id = str(flags, "run") ?? (await latestRunId(outRoot));
  if (!id) throw new UsageError(`no runs under ${outRoot}/runs — run a crawl first`);
  const dir = runDir(outRoot, id);
  if (!(await pathExists(path.join(dir, "crawl-map.json")))) {
    throw new UsageError(`no run manifest at ${dir}/crawl-map.json`);
  }
  return { id, dir };
}

async function cmdExport(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const dest = str(flags, "dest");
  if (!dest) throw new UsageError("export needs a directory: visualice export <dir>");
  const config = await loadConfigWithOverrides(flags);
  const outRoot = path.resolve(config.output.dir);
  const run = await resolveRun(outRoot, flags);

  const viewerDist = path.join(PROJECT_ROOT, "viewer", "dist");
  await ensureViewerBuilt(viewerDist, log);

  const result = await exportRun({
    runDir: run.dir,
    runId: run.id,
    viewerDist,
    dest,
  });
  if (flags.json === true) {
    console.log(JSON.stringify(result));
  } else {
    log(`exported run ${result.runId} — ${result.files} files`);
    log("serve it with any static file server, e.g. 'npx serve <dir>'");
    console.log(result.dest);
  }
}

async function cmdServe(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const outRoot = path.resolve(config.output.dir);
  // Resolve `latest` up front: without the symlink (Windows, a copied tree) it falls
  // back to the newest run directory instead of failing the existence check.
  const runId = str(flags, "run") ?? (await latestRunId(outRoot)) ?? "latest";
  const dir = runDir(outRoot, runId);
  if (!(await pathExists(path.join(dir, "viewer-data.json")))) {
    throw new Error(
      `no run data at ${dir}/viewer-data.json — run a crawl first (e.g. 'visualice crawl').`,
    );
  }

  const viewerDist = path.join(PROJECT_ROOT, "viewer", "dist");
  await ensureViewerBuilt(viewerDist, log);

  const server = await serveViewer({
    runDir: dir,
    viewerDist,
    // Sibling runs are exposed too, so the viewer's run switcher has somewhere to go.
    outRoot,
    runId,
    port: parsePort(flags),
  });

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

/** Write the minimal project config + make sure `.visualice/` is gitignored. */
async function scaffoldProject(target: string | undefined, log: Log): Promise<string> {
  const file = path.resolve("visualice.config.json");
  const body = {
    $schema: "node_modules/visualice/config.schema.json",
    ...(target ? { target } : {}),
  };
  await fs.writeFile(file, JSON.stringify(body, null, 2) + "\n");
  log(`wrote ${file}`);

  const gitignore = path.resolve(".gitignore");
  const existing = await fs.readFile(gitignore, "utf8").catch(() => undefined);
  const has = existing?.split("\n").some((l) => l.trim().replace(/\/$/, "") === ".visualice");
  if (!has) {
    const next =
      existing === undefined ? ".visualice/\n" : `${existing.replace(/\n?$/, "\n")}.visualice/\n`;
    await fs.writeFile(gitignore, next);
    log("added .visualice/ to .gitignore");
  }
  return file;
}

async function cmdInit(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const target = str(flags, "base");
  const file = path.resolve("visualice.config.json");
  if ((await pathExists(file)) && flags.force !== true) {
    throw new UsageError(`${file} already exists — pass --force to overwrite`);
  }
  await scaffoldProject(target, log);
  console.log(file);
  if (!target) log(`set "target" in the config, or rerun: visualice init <url>`);
  log(`next: visualice crawl`);
}

async function cmdCrawl(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const configPath = await resolveConfigPath(flags);
  const config = applyOverrides(await loadConfig(configPath), flags);
  const baseUrl = str(flags, "base") ?? config.target;
  if (!baseUrl)
    throw new UsageError(
      "no base URL: pass a url (visualice crawl <url>) or run 'visualice init <url>'",
    );
  // First crawl in a fresh project: persist the target so `visualice crawl` alone
  // works from now on. --no-save opts out.
  if (!configPath && str(flags, "base") && flags["no-save"] !== true) {
    await scaffoldProject(baseUrl, log);
  }
  const { runDir, manifest } = await crawlPipeline({
    config,
    baseUrl,
    replay: flags.replay === true,
    resume: flags.resume === true,
    log,
  });
  reportDone(runDir, manifest, flags, log);
}

async function cmdRoutes(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const file = routesFilePath(config);
  if (!file) throw new UsageError("routesFile is disabled (false) in the config");
  const cachePath = modelCachePath(path.resolve(config.output.dir));
  if (!(await pathExists(cachePath))) {
    throw new UsageError(`no cached site model at ${cachePath} — run 'visualice crawl' first`);
  }
  const model = await loadInputManifest(cachePath);
  const intent = await loadRoutesIntent(config);
  const target = config.target ?? intent.target ?? "unknown";
  await writeRoutesFile(config, model, intent, target, log);
  const wanted = computeWanted(model, intent);
  const states = countStates(model.routes);
  if (flags.json === true) {
    console.log(JSON.stringify({ file, routes: model.routes.length, states, wanted }));
  } else {
    console.log(file);
    if (wanted.length) log(`${wanted.length} wanted state(s) still need authoring`);
  }
}

async function cmdAuth(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfig(await resolveConfigPath(flags));
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
  const intent = await loadRoutesIntent(config);
  const inputManifest = await discoverPipeline({
    config: applyRoutesIntent(config, intent),
    baseUrl,
    log,
  });
  const cachePath = modelCachePath(path.resolve(config.output.dir));
  await saveJson(cachePath, inputManifest);
  await writeRoutesFile(config, inputManifest, intent, baseUrl, log);
  const states = countStates(inputManifest.routes);
  if (flags.json === true) {
    console.log(JSON.stringify({ cachePath, routes: inputManifest.routes.length, states }));
  } else {
    log("");
    log(`discovered ${inputManifest.routes.length} routes, ${states} states`);
    console.log(cachePath);
  }
}

/**
 * Serve the bundled fixture for the length of a demo run and report its result.
 * Demos run inside this repo — never scaffold a routes file here.
 */
async function runDemo(
  flags: Flags,
  run: (
    config: Config,
    baseUrl: string,
    log: Log,
  ) => Promise<{ runDir: string; manifest: Manifest }>,
): Promise<void> {
  const log = makeLog(flags);
  const server = await serveDirectory(FIXTURE_DIR);
  log(`fixture served at ${server.url}`);
  try {
    const config = { ...(await loadConfig(str(flags, "config"))), routesFile: false as const };
    const { runDir, manifest } = await run(config, server.url, log);
    reportDone(runDir, manifest, flags, log);
  } finally {
    await server.close();
  }
}

function cmdDemoCrawl(flags: Flags): Promise<void> {
  return runDemo(flags, (config, baseUrl, log) =>
    crawlPipeline({ config, baseUrl, replay: flags.replay === true, log }),
  );
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

function cmdDemo(flags: Flags): Promise<void> {
  return runDemo(flags, async (config, baseUrl, log) => {
    const inputManifest = await loadInputManifest(path.join(FIXTURE_DIR, "crawl-map.input.json"));
    return capturePipeline({ config, inputManifest, baseUrl, log });
  });
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
  if (!isCommand(cmd)) {
    console.error(`unknown command: ${cmd}`);
    printHelp();
    process.exitCode = 2;
    return;
  }
  const flags = parseFlags(cmd, rest);
  switch (cmd) {
    case "init":
      return cmdInit(flags);
    case "crawl":
      return cmdCrawl(flags);
    case "routes":
      return cmdRoutes(flags);
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
    case "doctor":
      return cmdDoctor(flags);
    case "export":
      return cmdExport(flags);
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
