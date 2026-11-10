import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { ConfigLoadError, loadConfig, type Config } from "./shared/config";
import {
  isCommand,
  UsageError,
  applyOverrides,
  csv,
  parseFlags,
  str,
  type Flags,
} from "./cli-args";
import { countStates, loadInputManifest, modelCachePath } from "./crawl/manifest";
import { InputManifestSchema, formatManifestIssues } from "./shared/manifest-schema";
import {
  capturePipeline,
  crawlPipeline,
  discoverOnlyPipeline,
  planCrawl,
  previewRoutes,
  type CrawlPlan,
} from "./crawl/orchestrator";
import { computeChanges, type ChangesReport } from "./crawl/changes";
import { CONFIG_FILES, findConfigFile, hashFile } from "./crawl/source";
import { setHeaded } from "./shared/launch";
import {
  computeWanted,
  loadRoutesIntent,
  routesFilePath,
  writeRoutesFile,
} from "./crawl/routes-file";
import { ensureStorageState } from "./crawl/auth";
import { pathExists } from "./shared/fsx";
import {
  knownUpdate,
  startUpdateCheck,
  updateCheckDisabled,
  type UpdateCheck,
} from "./shared/update-check";
import { nodeBinCommand } from "./shared/node-bin";
import { serveDirectory } from "./shared/static-server";
import { serveViewer } from "./serve";
import { formatDoctor, runDoctor } from "./doctor";
import {
  latestRunId,
  listRuns,
  listSites,
  migrateFlatRuns,
  newestSite,
  runDir,
  siteDir,
  siteKey,
} from "./crawl/runs";
import type { Manifest, RecipeStep, SourceInfo } from "./shared/types";
import { exportRun } from "./export";
import { probePage } from "./crawl/probe";
import { listAuthoredFiles, mergeAuthored, readAuthoredFile } from "./crawl/author";
import { acquireLock, LockedError } from "./shared/lock";
import { saveJson } from "./crawl/manifest";
import { RecipeStepSchema } from "./shared/manifest-schema";
import { canonicalPath } from "./shared/url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const FIXTURE_DIR = path.join(PROJECT_ROOT, "tests", "fixture");

/** Explicit --config wins; otherwise a visualice.config.* in the cwd is picked up. */
async function resolveConfigPath(flags: Flags): Promise<string | undefined> {
  return findConfigFile(process.cwd(), str(flags, "config"));
}

async function loadConfigWithOverrides(flags: Flags): Promise<Config> {
  return applyOverrides(await loadConfig(await resolveConfigPath(flags)), flags);
}

type Log = (msg: string) => void;
const makeLog = (flags: Flags): Log => (flags.quiet === true ? () => {} : (m) => console.error(m));

function printHelp(): void {
  console.log(`visualice — crawl a site and capture pages + UI states across devices

Usage:
  visualice init [url]        Scaffold visualice.config.json (+ .gitignore entry; --force overwrites)
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
  visualice probe <path>      Report a page's inventory, or what a recipe does on it (JSON)
  visualice author [dir|file] Merge explorer state files (.visualice/explore/) into the cache
  visualice changes [opts]    What changed in git since the catalogue was shot, and what to rerun
  visualice serve [opts]      Launch the zoomable results viewer
  visualice --version         Print the version

An installed CLI says on stderr when a newer version is out (checked at most daily);
VISUALICE_NO_UPDATE_CHECK=1, --quiet or CI turns that off.

Project files: visualice.config.json controls behavior; visualice.routes.md lists
pages + UI states and is regenerated after every crawl (edit it: 'skip:' excludes,
'[ ]' requests a state). A visualice.config.* in the cwd is picked up automatically.

Options (flags accept --name=value or --name value):
  --config=<path>      config file (.ts/.js/.json); cwd auto-detection if omitted
  --target=<url>       site to crawl (overrides config.target); also the bare [url] arg
  --seed=<paths>       for 'crawl'/'discover': extra entry pages, added to config.seeds (comma-separated)
  --no-states          for 'crawl'/'discover': pages only, no UI states (faster; cached states are kept)
  --dry-run            for 'crawl': discover, then list what would be captured instead of capturing it
  --no-save            for 'crawl': don't scaffold a config on first run
  --manifest=<path>    input manifest for 'capture' / 'validate'
  --replay             for 'crawl'/'demo-crawl': reuse cached site model, skip discovery
  --resume             for 'crawl': continue the newest interrupted run
  --only=<paths>       for 'crawl': shoot only these pages (paths or globs, comma-separated);
                       every other page's shots are carried over from the last run
  --discover           for 'changes': also map the site's pages, to list new and removed ones
  --json               print a machine-readable JSON summary to stdout
  --quiet              suppress progress output on stderr
  --fail-on-error      exit 3 if any capture failed
  --headed             show the browser windows (crawl, discover, capture, auth, probe)
  --max-pages=<n>      override scope.maxPages
  --include=<globs>    override scope.include (comma-separated)
  --exclude=<globs>    override scope.exclude (comma-separated)
  --devices=<names>    capture only these configured devices (comma-separated)
  --concurrency=<n>    override politeness.concurrency
  --timeout-ms=<ms>    override politeness.timeoutMs
  --dir=<dir>          override output.dir (default .visualice)
  --site=<name>        the site's folder under <dir>/sites/: which one 'serve'/'export' open
                       (default: this project's, else the last crawled); where 'crawl',
                       'discover' and 'capture' write (overrides output.site)
  --run=<id>           for 'serve'/'export': which run of that site (default: its latest)
  --port=<n>           for 'serve'/'fixture': fixed port (default: random)
  --open               for 'serve'/'fixture': open in your browser
  --screenshot=<file>  for 'serve': headless-screenshot the viewer to a file, then exit
  --no-fix             for 'doctor': report problems without repairing them
  --recipe=<json|@file> for 'probe': steps to run on the page (a JSON array)
  --state=<id>         for 'probe': run the cached recipe of this page's state
  --device=<name>      for 'probe': probe as this configured device (default: first)
  --shot=<file>        for 'probe': write a viewport screenshot (CSS px) after the recipe
  --inventory          for 'probe': with a recipe, also inventory the page it leaves
  --all-devices        for 'probe': also run the recipe on every configured device

Renamed (still accepted, with a warning): --base → --target, --shoot → --screenshot,
--out → --dir, --timeout → --timeout-ms.

Exit codes: 0 ok · 1 error · 2 usage · 3 capture failures (with --fail-on-error)

Output lands under <config.output.dir>/sites/<site>/runs/<runId>/ (default .visualice/).`);
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
        ...(stats?.carried !== undefined ? { carried: stats.carried } : {}),
        failed: stats?.failed ?? 0,
        failures: stats?.failures ?? [],
        wanted: stats?.wanted ?? [],
        ...(stats?.accessibility ? { accessibility: stats.accessibility } : {}),
      }),
    );
  } else {
    log("");
    log(
      `done — ${stats?.shots ?? 0} screenshots` +
        (stats?.carried ? ` (+${stats.carried} carried over)` : "") +
        (stats?.failed ? `, ${stats.failed} FAILED` : ""),
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
  const baseUrl = str(flags, "target") ?? config.target;
  if (!baseUrl) throw new UsageError("no target URL: pass --target=<url> or set target in config");

  const inputManifest = await loadInputManifest(manifestPath);
  const configFile = await resolveConfigPath(flags);
  const { runDir, manifest } = await capturePipeline({
    config,
    inputManifest,
    baseUrl,
    configFile,
    log,
  });
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
  const build = nodeBinCommand("vite", ["build", "viewer"], PROJECT_ROOT);
  if (!build)
    throw new Error("the viewer isn't built and vite isn't installed — run 'npm install'");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(...build, {
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
    // The boot loader holds for a couple of seconds and then fades: wait until it's
    // gone, or the screenshot is of the loader, not the canvas.
    await page
      .getByRole("status", { name: "Loading" })
      .waitFor({ state: "detached", timeout: 15_000 })
      .catch(() => {});
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
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

/**
 * Sort runs left in the old flat layout into their sites. Under the lock, so a crawl
 * mid-write isn't moved; when one is running it has already done this itself.
 */
async function migrateRuns(outRoot: string, log: Log): Promise<void> {
  if (!(await pathExists(path.join(outRoot, "runs")))) return;
  const lock = await acquireLock(outRoot, { log }).catch((e: unknown) => {
    if (e instanceof LockedError) return undefined;
    throw e;
  });
  if (!lock) return;
  try {
    await migrateFlatRuns(outRoot, log);
  } finally {
    await lock.release();
  }
}

/**
 * The run a command should act on. Site: `--site`, else this project's own (from
 * `output.site` or the target) when it has runs, else whichever site was crawled
 * last. Run: `--run`, else that site's latest.
 */
async function resolveRun(
  config: Config,
  flags: Flags,
  log: Log,
): Promise<{ outRoot: string; site: string; id: string; dir: string }> {
  const outRoot = path.resolve(config.output.dir);
  await migrateRuns(outRoot, log);
  const sites = await listSites(outRoot);
  const asked = str(flags, "site");
  if (asked && !sites.includes(asked)) {
    throw new UsageError(
      `no runs for site '${asked}' under ${outRoot}/sites` +
        (sites.length ? ` (have: ${sites.join(", ")})` : ""),
    );
  }
  const own = config.target ? siteKey(config.target, config.output.site) : config.output.site;
  const site =
    asked ?? (own && sites.includes(own) ? own : undefined) ?? (await newestSite(outRoot));
  if (!site) throw new UsageError(`no runs under ${outRoot}/sites — run a crawl first`);
  const root = siteDir(outRoot, site);
  const id = str(flags, "run") ?? (await latestRunId(root));
  if (!id) throw new UsageError(`no runs for site '${site}' — run a crawl first`);
  const dir = runDir(root, id);
  if (!(await pathExists(path.join(dir, "crawl-map.json")))) {
    throw new UsageError(`no run manifest at ${dir}/crawl-map.json`);
  }
  return { outRoot, site, id, dir };
}

async function cmdExport(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const dest = str(flags, "dest");
  if (!dest) throw new UsageError("export needs a directory: visualice export <dir>");
  const config = await loadConfigWithOverrides(flags);
  const run = await resolveRun(config, flags, log);

  const viewerDist = path.join(PROJECT_ROOT, "viewer", "dist");
  await ensureViewerBuilt(viewerDist, log);

  const result = await exportRun({
    runDir: run.dir,
    runId: run.id,
    site: run.site,
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
  // Resolve `latest` up front: without the symlink (Windows, a copied tree) it falls
  // back to the newest run directory.
  const { outRoot, site, id: runId, dir } = await resolveRun(config, flags, log);
  if (!(await pathExists(path.join(dir, "viewer-data.json")))) {
    throw new Error(
      `no run data at ${dir}/viewer-data.json — run a crawl first (e.g. 'visualice crawl').`,
    );
  }

  const viewerDist = path.join(PROJECT_ROOT, "viewer", "dist");
  await ensureViewerBuilt(viewerDist, log);

  // The viewer's update banner, from the same check as the terminal notice. Not in
  // a --screenshot, which is a picture of the catalogue, not of this install.
  const version = await readVersion();
  const update =
    str(flags, "screenshot") === undefined && (await updatesOn(flags))
      ? () => knownUpdate(version)
      : undefined;

  const server = await serveViewer({
    runDir: dir,
    viewerDist,
    // Every site's runs are exposed too, so the viewer's pickers have somewhere to go.
    outRoot,
    site,
    runId,
    port: parsePort(flags),
    update,
  });

  // Naming a site or run opens it; otherwise the page decides (the dashboard, when
  // there is more than one site).
  const named = str(flags, "site") !== undefined || str(flags, "run") !== undefined;
  const url = named
    ? `${server.url}/?${new URLSearchParams({ site, run: runId }).toString()}`
    : server.url;

  const screenshot = str(flags, "screenshot");
  if (screenshot !== undefined) {
    await shootViewer(url, screenshot);
    await server.close();
    log(`wrote ${screenshot}`);
    return;
  }

  log(`viewer serving ${site} run '${runId}' at:`);
  console.log(url);
  if (flags.open === true) openInBrowser(url);
  log("press Ctrl-C to stop.");
  await untilInterrupted();
  await server.close();
}

/** Write the minimal project config + make sure `.visualice/` is gitignored. */
async function scaffoldProject(target: string | undefined, log: Log): Promise<string> {
  const file = path.resolve("visualice.config.json");
  // A URL, not node_modules/…: a global or npx install has no local copy to point at.
  // Pinned to this version, so the editor checks against the keys this CLI reads.
  const body = {
    $schema: `https://unpkg.com/visualice@${await readVersion()}/config.schema.json`,
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
  const target = str(flags, "target");
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
  const baseUrl = str(flags, "target") ?? config.target;
  if (!baseUrl)
    throw new UsageError(
      "no base URL: pass a url (visualice crawl <url>) or run 'visualice init <url>'",
    );
  // First crawl in a fresh project: persist the target so `visualice crawl` alone
  // works from now on. --no-save opts out, and a dry run only looks.
  if (
    !configPath &&
    str(flags, "target") &&
    flags["no-save"] !== true &&
    flags["dry-run"] !== true
  ) {
    await scaffoldProject(baseUrl, log);
  }
  const pagesOnly = flags["no-states"] === true;
  const onlyFlag = str(flags, "only");
  const only = onlyFlag === undefined ? undefined : csv(onlyFlag);
  if (only && !only.length) throw new UsageError("--only needs at least one path or glob");
  if (flags["dry-run"] === true) {
    if (flags.resume === true) throw new UsageError("pass --dry-run or --resume, not both");
    const plan = await planCrawl({
      config,
      baseUrl,
      replay: flags.replay === true,
      pagesOnly,
      only,
      log,
    });
    reportPlan(plan, flags, log);
    return;
  }
  const { runDir, manifest } = await crawlPipeline({
    config,
    baseUrl,
    replay: flags.replay === true,
    resume: flags.resume === true,
    pagesOnly,
    only,
    configFile: configPath,
    log,
  });
  reportDone(runDir, manifest, flags, log);
}

/** `crawl --dry-run`: what would be captured. JSON on stdout when asked. */
function reportPlan(plan: CrawlPlan, flags: Flags, log: Log): void {
  if (flags.json === true) {
    console.log(JSON.stringify({ dryRun: true, ...plan }));
    return;
  }
  log("");
  for (const r of plan.routes) {
    const extra = r.states.filter((id) => id !== "default");
    console.log(`${r.url}${extra.length ? `  (+${extra.length}: ${extra.join(", ")})` : ""}`);
  }
  log(
    `dry run — ${plan.routes.length} page(s), ${plan.states} state(s), ` +
      `${plan.shots} screenshot(s) across ${plan.devices.join(", ")}; nothing captured`,
  );
  const p = plan.partial;
  if (p) {
    if (p.carriedFrom) {
      log(
        `  --only: shoot ${p.capture.length} page(s), carry ${p.carry.length} page(s) ` +
          `(${p.carriedShots} screenshot(s)) from run ${p.carriedFrom}`,
      );
      for (const f of p.forced)
        log(`    + ${f.url} shot too (${f.reason === "new" ? "new" : "incomplete in that run"})`);
    } else {
      log("  --only: no finished run to carry from, so every page would be shot");
    }
  }
  log(`  model : ${plan.cachePath}`);
}

/** The commit records in a site's runs, newest first. */
async function runSources(config: Config, baseUrl: string | undefined): Promise<SourceInfo[]> {
  const outRoot = path.resolve(config.output.dir);
  const site = baseUrl ? siteKey(baseUrl, config.output.site) : config.output.site;
  if (!site) return [];
  const root = siteDir(outRoot, site);
  const out: SourceInfo[] = [];
  for (const id of [...(await listRuns(root))].reverse()) {
    try {
      const m = JSON.parse(
        await fs.readFile(path.join(runDir(root, id), "crawl-map.json"), "utf8"),
      ) as Manifest;
      if (m.source?.commit) out.push(m.source);
    } catch {
      // An unfinished or unreadable run has no record to offer.
    }
  }
  return out;
}

async function cmdChanges(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const intent = await loadRoutesIntent(config);
  const baseUrl = str(flags, "target") ?? config.target ?? intent.target;
  const recorded = intent.source;
  // The run that matches the routes file's record holds its list of dirty files; with
  // no record in the file (not committed, or an older catalogue), the newest run's.
  const sources = await runSources(config, baseUrl);
  const runSource =
    (recorded &&
      (sources.find((s) => s.commit === recorded.commit && s.capturedAt === recorded.capturedAt) ??
        sources.find((s) => s.commit === recorded.commit))) ||
    (recorded ? undefined : sources[0]);

  const cachePath = modelCachePath(path.resolve(config.output.dir));
  const model = (await pathExists(cachePath)) ? await loadInputManifest(cachePath) : undefined;
  const pages = model?.routes.map((r) => r.url) ?? intent.routes.map((r) => r.path);

  let routes: ChangesReport["routes"];
  if (flags.discover === true) {
    if (!baseUrl)
      throw new UsageError("--discover needs a target: pass --target=<url> or set target");
    const preview = await previewRoutes({ config, baseUrl, log });
    routes = { added: preview.added, removed: preview.capped ? [] : preview.removed };
    if (preview.capped)
      log(
        `⚠ discovery stopped at scope.maxPages (${config.scope.maxPages}): removed pages aren't listed`,
      );
  }

  const routesFile = routesFilePath(config);
  const configFile = (await resolveConfigPath(flags)) ?? path.resolve("visualice.config.json");
  const report = await computeChanges({
    cwd: process.cwd(),
    recorded,
    runSource,
    ignore: [
      path.resolve(config.output.dir),
      ...(routesFile ? [routesFile] : []),
      ...CONFIG_FILES.map((name) => path.resolve(name)),
      configFile,
    ],
    config: { file: configFile, hash: await hashFile(configFile) },
    pages,
    routes,
  });
  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printChanges(report);
}

function printChanges(r: ChangesReport): void {
  const short = (c: string) => c.slice(0, 12);
  if (r.baseline) {
    const b = r.baseline;
    console.log(
      `catalogue: ${short(b.commit)}${b.branch ? ` (${b.branch})` : ""}` +
        `${b.dirty ? `, ${b.dirty} uncommitted change(s)` : ""}` +
        `${b.capturedAt ? `, shot ${b.capturedAt}` : ""}`,
    );
  }
  if (r.head) {
    console.log(
      `now:       ${short(r.head.commit)}${r.head.branch ? ` (${r.head.branch})` : ""}` +
        `${r.head.dirty ? `, ${r.head.dirty} uncommitted change(s)` : ""}` +
        (r.baseline ? ` — ${r.commitCount} commit(s) later` : ""),
    );
  }
  console.log(`verdict:   ${r.verdict}`);
  for (const reason of r.reasons) console.log(`  · ${reason}`);
  if (r.global.length) {
    console.log("\nchanges every page:");
    for (const g of r.global) console.log(`  ${g.path}  (${g.reason})`);
  }
  if (r.candidates.length) {
    console.log("\npages by file:");
    for (const c of r.candidates) {
      const pages = c.pages.length ? c.pages.join(", ") : "no page in the catalogue yet";
      console.log(
        `  ${c.file}  →  ${c.pattern}${c.kind === "layout" ? " (layout)" : ""}: ${pages}`,
      );
    }
  }
  if (r.unmapped.length) {
    console.log("\nno page on their own (trace who imports them):");
    for (const f of r.unmapped) console.log(`  ${f}`);
  }
  if (r.routes) {
    if (r.routes.added.length) console.log(`\nnew pages: ${r.routes.added.join(", ")}`);
    if (r.routes.removed.length) console.log(`gone pages: ${r.routes.removed.join(", ")}`);
  }
  if (r.suggest) console.log(`\nnext: ${r.suggest.command}`);
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
  const baseUrl = str(flags, "target") ?? config.target;
  if (!baseUrl) throw new UsageError("no target URL: pass --target=<url> or set target in config");
  const { inputManifest, cachePath } = await discoverOnlyPipeline({
    config,
    baseUrl,
    pagesOnly: flags["no-states"] === true,
    log,
  });
  const states = countStates(inputManifest.routes);
  if (flags.json === true) {
    console.log(JSON.stringify({ cachePath, routes: inputManifest.routes.length, states }));
  } else {
    log("");
    log(`discovered ${inputManifest.routes.length} routes, ${states} states`);
    console.log(cachePath);
  }
}

async function cmdAuthor(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const outRoot = path.resolve(config.output.dir);
  const cachePath = modelCachePath(outRoot);
  if (!(await pathExists(cachePath))) {
    throw new UsageError(`no cached site model at ${cachePath} — run 'visualice crawl' first`);
  }
  const files = await listAuthoredFiles(str(flags, "from") ?? path.join(outRoot, "explore"));
  const authored = await Promise.all(files.map(readAuthoredFile));
  const baseUrl = str(flags, "target") ?? config.target ?? "http://localhost";
  const canonical = (p: string) => {
    try {
      return canonicalPath(new URL(p, baseUrl), config.scope.hashRoutes);
    } catch {
      return p;
    }
  };

  const lock = await acquireLock(outRoot, { log });
  try {
    const result = mergeAuthored(await loadInputManifest(cachePath), authored, canonical);
    await saveJson(cachePath, result.model);
    // Proposed pages become seed lines, so the next --replay discovers them.
    const intent = await loadRoutesIntent(config);
    for (const page of result.proposedPages) {
      if (!intent.routes.some((r) => r.path === page))
        intent.routes.push({ path: page, states: [] });
    }
    if (routesFilePath(config)) {
      await writeRoutesFile(
        config,
        result.model,
        intent,
        config.target ?? intent.target ?? "unknown",
        log,
      );
    }
    const summary = {
      cachePath,
      files: files.length,
      added: result.added,
      replaced: result.replaced,
      unknownPages: result.unknownPages,
      proposedPages: result.proposedPages,
    };
    if (flags.json === true) {
      console.log(JSON.stringify(summary));
    } else {
      log(
        `${result.added.length} state(s) added, ${result.replaced.length} replaced from ${files.length} file(s)`,
      );
      if (result.proposedPages.length) {
        log(
          `${result.proposedPages.length} new page(s) seeded in the routes file: ${result.proposedPages.join(", ")}`,
        );
      }
      if (result.unknownPages.length) {
        log(
          `skipped states for page(s) the model doesn't have yet: ${result.unknownPages.join(", ")}` +
            ` — run 'visualice crawl --replay' to discover them, then author again`,
        );
      }
      console.log(cachePath);
    }
  } finally {
    await lock.release();
  }
}

/** `--recipe` as given: inline JSON, or `@file` for a JSON file. Validated as steps. */
async function readRecipeFlag(value: string): Promise<RecipeStep[]> {
  const text = value.startsWith("@")
    ? await fs.readFile(path.resolve(value.slice(1)), "utf8")
    : value;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`--recipe is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = RecipeStepSchema.array().safeParse(Array.isArray(raw) ? raw : [raw]);
  if (!parsed.success) {
    throw new UsageError(`--recipe: ${formatManifestIssues(parsed.error).join("; ")}`);
  }
  return parsed.data as RecipeStep[];
}

async function cmdProbe(flags: Flags): Promise<void> {
  const log = makeLog(flags);
  const config = await loadConfigWithOverrides(flags);
  const baseUrl = str(flags, "target") ?? config.target;
  if (!baseUrl) throw new UsageError("no target URL: pass --target=<url> or set target in config");
  const page = str(flags, "page");
  if (!page) throw new UsageError("which page? visualice probe <path> [--recipe=…]");
  const recipeFlag = str(flags, "recipe");
  const stateId = str(flags, "state");
  if (recipeFlag && stateId) throw new UsageError("pass --recipe or --state, not both");

  // The cached model says what this page already has, so an explorer doesn't author
  // a state twice — and holds the recipe `--state` replays.
  const cachePath = modelCachePath(path.resolve(config.output.dir));
  const model = (await pathExists(cachePath)) ? await loadInputManifest(cachePath) : undefined;
  const key = canonicalPath(new URL(page, baseUrl), config.scope.hashRoutes);
  const route = model?.routes.find((r) => r.url === page || r.url === key);
  let recipe = recipeFlag ? await readRecipeFlag(recipeFlag) : undefined;
  if (stateId) {
    const state = route?.states.find((s) => s.id === stateId);
    if (!state) {
      throw new UsageError(
        `no state "${stateId}" on ${page} in the cached model` +
          (route ? ` (has: ${route.states.map((s) => s.id).join(", ")})` : ""),
      );
    }
    recipe = state.recipe;
  }

  const storageState = await ensureStorageState(config, log);
  const shot = str(flags, "shot");
  const allDevices = flags["all-devices"] === true;
  if (allDevices && !recipe) {
    throw new UsageError("--all-devices checks a recipe: pass --recipe or --state");
  }
  if (allDevices && str(flags, "device")) {
    throw new UsageError("pass --device or --all-devices, not both");
  }
  const probeOn = (device: string | undefined, shotPath: string | undefined) =>
    probePage({
      config,
      baseUrl,
      url: route?.url ?? page,
      recipe,
      device,
      storageState,
      shotPath,
      inventory: flags.inventory === true,
    });
  const result = await probeOn(str(flags, "device"), shot ? path.resolve(shot) : undefined);

  // A recipe verified on one device can still fail on another: a label hidden at
  // phone width, a control that moves into a menu. Capture replays it on all of them.
  let devices: Record<string, { ok: boolean; error?: unknown; shot?: string }> | undefined;
  if (allDevices) {
    devices = {};
    for (const [i, device] of config.devices.entries()) {
      const ext = shot ? path.extname(shot) : "";
      const own = shot
        ? path.resolve(`${shot.slice(0, shot.length - ext.length)}.${device.name}${ext}`)
        : undefined;
      const outcome = (i === 0 ? result : await probeOn(device.name, own)) as {
        ok?: boolean;
        error?: unknown;
      };
      devices[device.name] = {
        ok: outcome.ok ?? true,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(i > 0 && own ? { shot: own } : {}),
      };
    }
  }

  const cached = route?.states.map((s) => ({ id: s.id, kind: s.kind, label: s.label }));
  console.log(
    JSON.stringify(
      {
        page: route?.url ?? page,
        known: !!route,
        ...(cached ? { states: cached } : {}),
        ...result,
        ...(devices ? { devices } : {}),
      },
      null,
      2,
    ),
  );
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

async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

async function printVersion(): Promise<void> {
  console.log(await readVersion());
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
  setHeaded(flags.headed === true);
  const update = await updateCheck(flags);
  if (update?.notice) console.error(`ℹ ${update.notice}`);
  try {
    await runCommand(cmd, flags);
  } finally {
    // Let a background registry lookup save its answer, but never hold a finished
    // command up for long: an unanswered lookup is simply tried again next time.
    if (update) await Promise.race([update.refreshed, delay(1500)]);
  }
}

/**
 * The update check, for an installed CLI. A source checkout (this repo, or one
 * `npm link`ed) is never "behind" in a way worth telling, and `--quiet` asks for silence.
 */
async function updateCheck(flags: Flags): Promise<UpdateCheck | undefined> {
  if (!(await updatesOn(flags))) return undefined;
  try {
    return await startUpdateCheck(await readVersion());
  } catch {
    return undefined;
  }
}

/** Is the update check (terminal notice and viewer banner) on for this run? */
async function updatesOn(flags: Flags): Promise<boolean> {
  if (flags.quiet === true || updateCheckDisabled()) return false;
  return !(await pathExists(path.join(PROJECT_ROOT, ".git")));
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

async function runCommand(cmd: string, flags: Flags): Promise<void> {
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
    case "probe":
      return cmdProbe(flags);
    case "author":
      return cmdAuthor(flags);
    case "changes":
      return cmdChanges(flags);
  }
}

main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(e.message);
    process.exit(2);
  }
  if (e instanceof ConfigLoadError) {
    console.error(e.message);
    process.exit(1);
  }
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
