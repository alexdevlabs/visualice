import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { loadConfig } from "./shared/config";
import { loadInputManifest, saveJson } from "./crawl/manifest";
import { capturePipeline, crawlPipeline } from "./crawl/orchestrator";
import { discoverPipeline } from "./crawl/discover";
import { ensureStorageState } from "./crawl/auth";
import { serveDirectory } from "./shared/static-server";
import { serveViewer } from "./serve";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(PROJECT_ROOT, "tests", "fixture");

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): Flags {
  const f: Flags = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq >= 0) f[a.slice(2, eq)] = a.slice(eq + 1);
    else f[a.slice(2)] = true;
  }
  return f;
}

const log = (m: string) => console.error(m);

function printHelp(): void {
  console.log(`visual-crawl — crawl a site and capture pages + UI states across devices

Usage:
  visual-crawl crawl [opts]               Discover routes + UI states, then capture across devices
  visual-crawl discover [opts]            Auto-discover routes + UI states (no screenshots)
  visual-crawl auth [--force]             Run the configured login recipe → save storage state
  visual-crawl capture [opts]             Replay a given manifest's recipes and capture screenshots
  visual-crawl demo                       Capture the bundled fixture from a hand-written manifest
  visual-crawl demo-crawl                 Full discover→capture run against the bundled fixture
  visual-crawl serve [opts]               Launch the zoomable results viewer

options:
  --config=<path>      config file (.ts/.js/.json); defaults applied if omitted
  --base=<url>         base URL (overrides config.target)
  --manifest=<path>    input manifest for 'capture' [required for capture]
  --replay             for 'crawl': reuse cached site model, skip discovery
  --run=<id>           for 'serve': which run to view (default: latest)
  --port=<n>           for 'serve': fixed port (default: random)
  --open               for 'serve': open the viewer in your browser

Output lands under <config.output.dir>/runs/<runId>/ (default .visual-crawl/).`);
}

async function cmdCapture(flags: Flags): Promise<void> {
  const config = await loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  const manifestPath = typeof flags.manifest === "string" ? flags.manifest : undefined;
  if (!manifestPath) throw new Error("capture requires --manifest=<path>");
  const baseUrl = (typeof flags.base === "string" ? flags.base : undefined) ?? config.target;
  if (!baseUrl) throw new Error("no base URL: pass --base=<url> or set target in config");

  const inputManifest = await loadInputManifest(manifestPath);
  const { runDir, manifest } = await capturePipeline({ config, inputManifest, baseUrl, log });
  reportDone(runDir, manifest.stats?.shots ?? 0);
}

async function pathExists(p: string): Promise<boolean> {
  return !!(await fs.stat(p).catch(() => null));
}

async function ensureViewerBuilt(viewerDist: string): Promise<void> {
  if (await pathExists(path.join(viewerDist, "index.html"))) return;
  log("building viewer (first run)…");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["vite", "build", "viewer"], { cwd: PROJECT_ROOT, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`vite build failed (${code})`))));
  });
}

async function shootViewer(url: string, outFile: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    await page.screenshot({ path: outFile });
  } finally {
    await browser.close();
  }
}

async function cmdServe(flags: Flags): Promise<void> {
  const config = await loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  const outRoot = path.resolve(config.output.dir);
  const runId = typeof flags.run === "string" ? flags.run : "latest";
  const runDir = path.join(outRoot, "runs", runId);
  if (!(await pathExists(path.join(runDir, "viewer-data.json")))) {
    throw new Error(`no run data at ${runDir}/viewer-data.json — run a crawl first (e.g. 'visual-crawl crawl').`);
  }

  const viewerDist = path.join(PROJECT_ROOT, "viewer", "dist");
  await ensureViewerBuilt(viewerDist);

  const server = await serveViewer({
    runDir,
    viewerDist,
    port: typeof flags.port === "string" ? Number(flags.port) : undefined,
  });

  if (typeof flags.shoot === "string") {
    await shootViewer(server.url, flags.shoot);
    await server.close();
    log(`wrote ${flags.shoot}`);
    return;
  }

  log(`viewer serving run '${runId}' at:`);
  console.log(server.url);
  if (flags.open === true) spawn("open", [server.url]);
  log("press Ctrl-C to stop.");
  await new Promise<never>(() => {}); // keep alive
}

async function cmdCrawl(flags: Flags): Promise<void> {
  const config = await loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  const baseUrl = (typeof flags.base === "string" ? flags.base : undefined) ?? config.target;
  if (!baseUrl) throw new Error("no base URL: pass --base=<url> or set target in config");
  const { runDir, manifest } = await crawlPipeline({ config, baseUrl, replay: flags.replay === true, log });
  reportDone(runDir, manifest.stats?.shots ?? 0);
}

async function cmdAuth(flags: Flags): Promise<void> {
  const config = await loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  if (!config.auth.storageStatePath) {
    throw new Error("config.auth.storageStatePath is not set — nothing to authenticate.");
  }
  if (typeof flags.force === "boolean" && flags.force) {
    await fs.rm(path.resolve(config.auth.storageStatePath), { force: true }).catch(() => {});
  }
  const sp = await ensureStorageState(config, log);
  log(sp ? `auth ready: ${sp}` : "no login recipe configured; nothing to do.");
}

async function cmdDiscover(flags: Flags): Promise<void> {
  const config = await loadConfig(typeof flags.config === "string" ? flags.config : undefined);
  const baseUrl = (typeof flags.base === "string" ? flags.base : undefined) ?? config.target;
  if (!baseUrl) throw new Error("no base URL: pass --base=<url> or set target in config");
  const inputManifest = await discoverPipeline({ config, baseUrl, log });
  const cachePath = path.join(path.resolve(config.output.dir), "crawl-map.cache.json");
  await saveJson(cachePath, inputManifest);
  const states = inputManifest.routes.reduce((n, r) => n + r.states.length, 0);
  log("");
  log(`discovered ${inputManifest.routes.length} routes, ${states} states`);
  console.log(cachePath);
}

async function cmdDemoCrawl(flags: Flags): Promise<void> {
  const server = await serveDirectory(FIXTURE_DIR);
  log(`fixture served at ${server.url}`);
  try {
    const config = await loadConfig();
    const { runDir, manifest } = await crawlPipeline({
      config,
      baseUrl: server.url,
      replay: flags.replay === true,
      log,
    });
    reportDone(runDir, manifest.stats?.shots ?? 0);
  } finally {
    await server.close();
  }
}

async function cmdDemo(): Promise<void> {
  const server = await serveDirectory(FIXTURE_DIR);
  log(`fixture served at ${server.url}`);
  try {
    const config = await loadConfig();
    const inputManifest = await loadInputManifest(path.join(FIXTURE_DIR, "crawl-map.input.json"));
    const { runDir, manifest } = await capturePipeline({
      config,
      inputManifest,
      baseUrl: server.url,
      log,
    });
    reportDone(runDir, manifest.stats?.shots ?? 0);
  } finally {
    await server.close();
  }
}

function reportDone(runDir: string, shots: number): void {
  log("");
  log(`done — ${shots} screenshots`);
  console.log(runDir);
  log(`  manifest : ${path.join(runDir, "crawl-map.json")}`);
  log(`  report   : ${path.join(runDir, "crawl-report.md")}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "crawl":
      return cmdCrawl(flags);
    case "discover":
      return cmdDiscover(flags);
    case "auth":
      return cmdAuth(flags);
    case "demo":
      return cmdDemo();
    case "demo-crawl":
      return cmdDemoCrawl(flags);
    case "capture":
      return cmdCapture(flags);
    case "serve":
      return cmdServe(flags);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      log(`unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
