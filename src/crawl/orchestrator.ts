import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";
import type {
  Manifest,
  InputManifest,
  QuietTrigger,
  WroteTrigger,
  RouteNode,
  SourceInfo,
  StateNode,
  ViewerData,
  ViewerTile,
} from "../shared/types";
import { matchesAny, routeMatches } from "../shared/glob";
import { runCapture } from "./capture";
import { renderReport } from "./report";
import {
  saveJson,
  mergeManifests,
  loadInputManifest,
  isAuthored,
  modelCachePath,
} from "./manifest";
import { discoverPipeline } from "./discover";
import { ensureStorageState } from "./auth";
import {
  applyRoutesIntent,
  applyStateSkips,
  computeWanted,
  loadRoutesIntent,
  unmappedRoutes,
  writeRoutesFile,
  type RoutesIntent,
} from "./routes-file";
import { pathExists } from "../shared/fsx";
import { pathSlug, stateSlug } from "../shared/slug";
import {
  findResumableRun,
  listRuns,
  markRunComplete,
  markRunIncomplete,
  migrateFlatRuns,
  runDir as runDirFor,
  runIdTime,
  runsToPrune,
  siteDir,
  siteKey,
  updateLatest,
} from "./runs";
import { redactConfig, redactUrl } from "../shared/redact";
import { acquireLock } from "../shared/lock";
import { applyHints, describeHints } from "../shared/hints";
import {
  type CarryPlan,
  carryRoute,
  findCarrySource,
  matchesOnly,
  planCarry,
  unmatchedOnly,
  verifyCarry,
} from "./carry";
import {
  type AccessibilityRollup,
  type AccessibilityViolation,
  mergeRollups,
  rollupViolations,
} from "./accessibility";
import { CONFIG_FILES, findConfigFile, readSource } from "./source";

type Log = (msg: string) => void;

export function makeRunId(date = new Date()): string {
  // Keep milliseconds so back-to-back/parallel runs don't share a run dir and
  // overwrite each other. `:` and `.` → `-` keeps the id lexically sortable
  // (millis are zero-padded to 3 digits, so chronological == lexical).
  return date.toISOString().replace(/[:.]/g, "-");
}

export interface CapturePipelineOptions {
  config: Config;
  inputManifest: InputManifest;
  baseUrl: string;
  /** Pre-resolved storageState path; if omitted, auth is resolved from config. */
  storageState?: string;
  /** Pre-parsed routes-file intent; if omitted, read from config.routesFile. */
  routesIntent?: RoutesIntent;
  /** Take the output-directory lock (default true; false when a caller holds it). */
  lock?: boolean;
  /** Reuse an interrupted run's directory and keep the shots it already produced. */
  resume?: string;
  /** Capture each page's default render only: no UI states, no components. */
  pagesOnly?: boolean;
  /**
   * Shoot only the routes these paths or globs match, and carry every other route's
   * shots over from the site's last finished run (`crawl --only`).
   */
  only?: string[];
  /** The commit being shot; read from the working directory's git when omitted. */
  source?: SourceInfo | null;
  /** The config file the run was loaded from (`--config`), for the source record's hash. */
  configFile?: string;
  /** What this run's discovery clicked that showed no change, for the report. */
  quiet?: QuietTrigger[];
  /** What it left out because clicking it wrote to the server. */
  wrote?: WroteTrigger[];
  log?: (msg: string) => void;
}

export interface CapturePipelineResult {
  runDir: string;
  manifest: Manifest;
}

/**
 * Flatten the manifest into the viewer's tile index.
 *
 * Failed captures become tiles too, carrying `error` instead of an image: a state
 * that silently vanishes from the canvas reads as "this UI doesn't exist", which is
 * the opposite of what a failure means. Their size falls back to the device
 * viewport so the layout can still reserve a place for them.
 */
export function toViewerData(m: Manifest): ViewerData {
  const tiles: ViewerTile[] = [];
  const deviceByName = new Map(m.devices.map((d) => [d.name, d]));
  let failed = 0;

  for (const r of m.routes) {
    const routePath = pathSlug(r.url);
    for (const s of r.states) {
      for (const [device, ref] of Object.entries(s.shots)) {
        if (!ref.full && !ref.error) continue;
        const profile = deviceByName.get(device);
        if (ref.error) failed++;
        tiles.push({
          id: `${r.id}__${s.id}__${device}`,
          routeId: r.id,
          routeUrl: r.url,
          routePath,
          stateId: s.id,
          stateLabel: s.label,
          stateKind: s.kind,
          device,
          full: ref.full,
          thumb: ref.thumb,
          mid: ref.mid,
          viewport: ref.viewport,
          width: ref.width ?? (profile ? profile.width * profile.dpr : undefined),
          height: ref.height ?? (profile ? profile.height * profile.dpr : undefined),
          clamped: ref.clamped,
          screens: ref.screens,
          frames: ref.frames,
          meta: ref.meta,
          a11y: ref.a11y,
          error: ref.error,
          ...(ref.carried
            ? { carried: ref.carried }
            : // Shot because `--only` named the page: not a failed carry, nor a page
              // shot only because the earlier run didn't have it.
              m.partial && ref.full && !ref.error && matchesOnly(r, m.partial.only)
              ? { updated: true }
              : {}),
        });
      }
    }
  }

  return {
    site: m.site,
    ...(m.source ? { source: m.source } : {}),
    ...(m.partial ? { partial: m.partial } : {}),
    devices: m.devices,
    tiles,
    groups: m.routes.map((r) => ({ path: pathSlug(r.url), routeId: r.id, title: r.title })),
    failed,
  };
}

function routePathOf(url: string): string {
  try {
    return new URL(url, "http://_local_").pathname;
  } catch {
    return url;
  }
}

/**
 * Add a state per configured component to every route its globs match.
 *
 * Components are config, not discovery: they are added to the run's copy of the
 * model on the way into capture and never written back to the cache, so removing
 * one from the config removes it from the next run. A state already carrying the
 * same id (hand-authored, with a recipe that opens something first) is left alone.
 */
export function withComponents(
  model: InputManifest,
  components: Config["components"],
): InputManifest {
  if (!components.length) return model;
  return {
    ...model,
    routes: model.routes.map((route) => {
      const added: StateNode[] = [];
      for (const c of components) {
        if (!matchesAny(routePathOf(route.url), c.routes)) continue;
        const id = `component-${stateSlug(c.name)}`;
        if (route.states.some((s) => s.id === id)) continue;
        added.push({
          id,
          kind: "component",
          label: c.name,
          recipe: [],
          element: c.selector,
          source: "auto",
          shots: {},
        });
      }
      return added.length ? { ...route, states: [...route.states, ...added] } : route;
    }),
  };
}

/**
 * Keep the newest `keep` runs, `current` among them. Ordering comes from the run ids'
 * timestamps rather than a lexical sort, and a failed delete is reported: silently
 * keeping runs is survivable, silently deleting the wrong one is not.
 *
 * `current` is the run just written, passed in rather than read back from `latest`:
 * if the symlink couldn't be made, `latest` falls back to whichever id sorts newest,
 * and under clock skew that isn't the run this crawl produced.
 */
async function pruneRuns(root: string, keep: number, current: string, log: Log): Promise<void> {
  // Only runs this tool generated are pruned *or counted*. A hand-named directory
  // (a copied-in baseline, say) is not ours to delete, and letting it occupy a slot
  // in the keep budget would silently push a real run out instead.
  const ids = (await listRuns(root)).filter((id) => runIdTime(id) !== undefined);
  for (const id of runsToPrune(ids, keep, current)) {
    try {
      await fs.rm(runDirFor(root, id), { recursive: true, force: true });
    } catch (e) {
      log(`⚠ could not prune old run ${id}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

/** Only each route's default render, for a pages-only run. */
export function pagesOnly(model: InputManifest): InputManifest {
  return {
    ...model,
    routes: model.routes.map((r) => ({
      ...r,
      states: r.states.filter((s) => s.kind === "default"),
    })),
  };
}

/**
 * The model a capture works through: routes-file skips subtracted, configured
 * components added, and with `pagesOnly` everything but the default renders dropped.
 */
function captureModel(
  model: InputManifest,
  intent: RoutesIntent,
  config: Config,
  onlyPages: boolean,
): InputManifest {
  const full = withComponents(applyStateSkips(model, intent), config.components);
  return onlyPages ? pagesOnly(full) : full;
}

/**
 * Hold the output directory's lock for the duration of `fn`, unless a caller up the
 * stack already holds it (crawl → capture is one run, not two).
 */
async function withLock<T>(
  outRoot: string,
  log: Log,
  enabled: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!enabled) return fn();
  const lock = await acquireLock(outRoot, { log });
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** Capture-only pipeline (M1): replay a manifest's recipes across all devices. */
export async function capturePipeline(
  opts: CapturePipelineOptions,
): Promise<CapturePipelineResult> {
  const log = opts.log ?? (() => {});
  const outRoot = path.resolve(opts.config.output.dir);
  return withLock(outRoot, log, opts.lock !== false, () => captureRun(opts));
}

async function captureRun(opts: CapturePipelineOptions): Promise<CapturePipelineResult> {
  const { baseUrl } = opts;
  const log = opts.log ?? (() => {});
  const id = opts.resume ?? makeRunId();
  const origin = new URL(baseUrl).origin;
  const outRoot = path.resolve(opts.config.output.dir);
  await migrateFlatRuns(outRoot, log);
  const site = siteDir(outRoot, siteKey(baseUrl, opts.config.output.site));
  const runDir = runDirFor(site, id);
  await fs.mkdir(runDir, { recursive: true });
  await markRunIncomplete(runDir);

  // Site hints (Explore-mode advice carried in the cached model) fold into the
  // config that drives this run.
  const config = applyHints(opts.config, opts.inputManifest.hints);
  const hintNote = describeHints(opts.inputManifest.hints);
  if (hintNote) log(hintNote);

  // The routes file subtracts (skip:) before capture, and its unmet requests
  // ([ ] lines) surface as `wanted` — the Explore-mode queue.
  const intent = opts.routesIntent ?? (await loadRoutesIntent(config));
  const inputManifest = captureModel(opts.inputManifest, intent, config, !!opts.pagesOnly);
  const wanted = opts.pagesOnly ? [] : computeWanted(opts.inputManifest, intent);

  const source =
    opts.source === undefined
      ? await readProjectSource(opts.config, baseUrl, opts.configFile)
      : opts.source;
  const manifest: Manifest = {
    version: 1,
    ...(source ? { source } : {}),
    site: {
      // Without the `user:pass@` a target may carry: the manifest is served and shared.
      baseUrl: redactUrl(baseUrl),
      origin,
      title: inputManifest.site?.title,
      framework: inputManifest.site?.framework,
      runId: id,
      generatedAt: new Date().toISOString(),
    },
    configSnapshot: redactConfig(config),
    devices: config.devices,
    auth: inputManifest.auth,
    routes: inputManifest.routes,
    hints: inputManifest.hints,
  };

  // A partial run shoots what `--only` names and carries the rest from the last
  // finished run; without one to carry from, it shoots everything.
  let carry: CarryPlan | undefined;
  // A resumed partial run is still partial: its plan was kept in the run folder.
  const only = opts.only ?? (opts.resume !== undefined ? await readPartialPlan(runDir) : undefined);
  if (only?.length) await savePartialPlan(runDir, only);
  const carrySource = only?.length ? await findCarrySource(site, id) : undefined;
  if (only?.length) {
    if (!carrySource) {
      log("--only: no finished run of this site to carry from — capturing every page");
    } else {
      carry = await verifyCarry(
        planCarry(manifest.routes, only, carrySource.manifest, config.devices),
        carrySource,
        config.devices,
      );
      logCarryPlan(carry, only, carrySource.runId, log);
      const unmatched = unmatchedOnly(manifest.routes, only);
      manifest.partial = {
        only,
        carriedFrom: carrySource.runId,
        ...(unmatched.length ? { unmatched } : {}),
      };
    }
  }

  const storageState = opts.storageState ?? (await ensureStorageState(config, log, baseUrl));

  const allRoutes = manifest.routes;
  if (carry) manifest.routes = carry.capture;
  const result = await runCapture({
    config,
    manifest,
    baseUrl,
    runDir,
    storageState,
    resume: opts.resume !== undefined,
    log,
  });

  if (carry && carrySource && result.manifest.stats) {
    let carried = 0;
    for (const route of carry.carry) {
      carried += await carryRoute(route, carrySource, runDir, config.devices);
    }
    // runCapture may have replaced the captured routes' state lists; the route
    // objects are the same ones, so the full list in its order is still right.
    result.manifest.routes = allRoutes;
    result.manifest.stats.routes = allRoutes.length;
    result.manifest.stats.states = allRoutes.reduce((n, r) => n + r.states.length, 0);
    result.manifest.stats.carried = carried;
    countCarryFailures(result.manifest.stats, carry.carry);
    // The capture rolled up only the pages it shot; the carried ones count too.
    if (result.manifest.stats.accessibility) {
      result.manifest.stats.accessibility = mergeRollups(
        result.manifest.stats.accessibility as AccessibilityRollup[],
        rollupViolations(await carriedViolations(carry.carry, runDir)),
      );
    }
    log(
      `carried ${carried} shot(s) of ${carry.carry.length} page(s) from run ${carrySource.runId}`,
    );
  }

  if (result.manifest.stats) {
    result.manifest.stats.complete =
      !opts.pagesOnly &&
      !result.manifest.stats.failed &&
      !result.manifest.partial?.unmatched?.length;
  }
  if (result.manifest.stats && opts.quiet?.length) result.manifest.stats.quiet = opts.quiet;
  if (result.manifest.stats && opts.wrote?.length) result.manifest.stats.wrote = opts.wrote;
  if (result.manifest.stats && wanted.length) {
    result.manifest.stats.wanted = wanted;
    log(`${wanted.length} wanted state(s) still need authoring (see routes file / report)`);
  }

  await saveJson(path.join(runDir, "crawl-map.json"), result.manifest);
  await saveJson(path.join(runDir, "viewer-data.json"), toViewerData(result.manifest));
  await fs.writeFile(path.join(runDir, "crawl-report.md"), renderReport(result.manifest));

  await markRunComplete(runDir);
  await updateLatest(site, id);
  await pruneRuns(site, config.output.keepRuns, id, log);

  return { runDir, manifest: result.manifest };
}

/** The commit checked out in the project, with crawl's own files left out of "dirty". */
export async function readProjectSource(
  config: Config,
  baseUrl: string,
  configFile?: string,
): Promise<SourceInfo | undefined> {
  // `configFile` is the --config the run was given; without one, the file a first
  // crawl may just have scaffolded is looked up now.
  const file = await findConfigFile(process.cwd(), configFile);
  return readSource(process.cwd(), {
    target: redactUrl(baseUrl),
    configFile: file,
    ignore: crawlOwnFiles(config, file),
  });
}

/**
 * The crawl's own files, whose changes are no change to the site: the output folder,
 * the routes file it rewrites, the config (compared by hash in `changes`, since a
 * first crawl scaffolds it) and the `.gitignore` that scaffold adds a line to. The
 * one list for the commit record and for `changes`, so both call the same tree dirty.
 */
export function crawlOwnFiles(config: Config, configFile?: string): string[] {
  const routesFile = config.routesFile === false ? undefined : path.resolve(config.routesFile);
  return [
    path.resolve(config.output.dir),
    ...(routesFile ? [routesFile] : []),
    ...CONFIG_FILES.map((name) => path.resolve(name)),
    ...(configFile ? [path.resolve(configFile)] : []),
    path.resolve(".gitignore"),
  ];
}

/** What the accessibility check found on each carried shot, from its sidecar file. */
async function carriedViolations(
  routes: RouteNode[],
  runDir: string,
): Promise<AccessibilityViolation[][]> {
  const out: AccessibilityViolation[][] = [];
  for (const route of routes) {
    for (const state of route.states) {
      for (const ref of Object.values(state.shots)) {
        if (ref.error || !ref.meta || !ref.a11y) continue;
        try {
          const sidecar = JSON.parse(await fs.readFile(path.join(runDir, ref.meta), "utf8")) as {
            accessibility?: AccessibilityViolation[];
          };
          if (Array.isArray(sidecar.accessibility)) out.push(sidecar.accessibility);
        } catch {
          // No sidecar to read: the shot keeps its count, the rollup goes without it.
        }
      }
    }
  }
  return out;
}

function logCarryPlan(plan: CarryPlan, only: string[], from: string, log: Log): void {
  log(
    `--only ${only.join(", ")}: shooting ${plan.capture.length} page(s), ` +
      `carrying ${plan.carry.length} from run ${from}`,
  );
  if (!plan.capture.some((r) => matchesOnly(r, only))) {
    log(`⚠ --only matched no page in the site model (${only.join(", ")})`);
  }
  for (const f of plan.forced) {
    log(
      `  + ${f.url}: shot too — ${f.reason === "new" ? "not in the earlier run" : "the earlier run is missing some of its shots"}`,
    );
  }
}

export interface CrawlPipelineOptions {
  config: Config;
  baseUrl: string;
  /** Reuse the cached site model (skip discovery) when available. */
  replay?: boolean;
  /** Continue the newest unfinished run instead of starting a new one. */
  resume?: boolean;
  /**
   * Discover and capture pages only, no UI states. Faster; states already in the
   * cache are kept for the next full crawl rather than dropped.
   */
  pagesOnly?: boolean;
  /**
   * Shoot only the pages these paths or globs match; every other page's shots are
   * carried over from the last finished run. With `replay`, the matched pages' states
   * are discovered again, since a changed page may have new ones.
   */
  only?: string[];
  /** The config file the run was loaded from (`--config`), for the source record's hash. */
  configFile?: string;
  log?: (msg: string) => void;
}

/** What a crawl would capture, without capturing it (`crawl --dry-run`). */
export interface CrawlPlan {
  cachePath: string;
  routes: { url: string; states: string[] }[];
  states: number;
  /** Screenshots the capture would take: each state on each device it applies to. */
  shots: number;
  devices: string[];
  /** With `--only`: what would be shot and what carried over, and from which run. */
  partial?: {
    only: string[];
    carriedFrom?: string;
    capture: string[];
    carry: string[];
    forced: CarryPlan["forced"];
    /** Screenshots carried instead of shot. */
    carriedShots: number;
  };
  /** Triggers discovery left out because clicking them wrote to the server. */
  wrote?: WroteTrigger[];
}

/**
 * Full pipeline (M2/M3 + M1): discover routes + UI states (or reuse the cached
 * model), then capture every state across all devices. The cached `crawl-map.cache.json`
 * is what makes subsequent `--replay` runs fast and deterministic.
 */
export async function crawlPipeline(opts: CrawlPipelineOptions): Promise<CapturePipelineResult> {
  const log = opts.log ?? (() => {});
  const outRoot = path.resolve(opts.config.output.dir);
  // One lock for discovery *and* capture: they share the cache and the auth state.
  return withLock(outRoot, log, true, () => crawlRun(opts, outRoot));
}

async function crawlRun(
  opts: CrawlPipelineOptions,
  outRoot: string,
): Promise<CapturePipelineResult> {
  const { config, baseUrl } = opts;
  const log = opts.log ?? (() => {});

  let resume: string | undefined;
  if (opts.resume) {
    await migrateFlatRuns(outRoot, log);
    resume = await findResumableRun(siteDir(outRoot, siteKey(baseUrl, config.output.site)));
    if (resume) log(`resuming run ${resume}`);
    else log("nothing to resume — starting a new run");
  }

  const { inputManifest, intent, storageState, quiet, wrote } = await crawlModel(opts, outRoot);
  const source = (await readProjectSource(config, baseUrl, opts.configFile)) ?? null;
  const result = await capturePipeline({
    config,
    inputManifest,
    baseUrl,
    storageState,
    routesIntent: intent,
    lock: false,
    resume,
    pagesOnly: opts.pagesOnly,
    only: opts.only,
    configFile: opts.configFile,
    source,
    quiet,
    wrote,
    log,
  });
  // The routes file now says which commit the catalogue shows, for `changes`. A rerun
  // of the same commit keeps the line it has, so the file only changes when the code
  // did. (Which files were dirty is in each run's manifest, which `changes` reads.)
  // Only a run that shot every state stands for the commit: one with failed shots,
  // or one that left the states out, would let `changes` call it up to date.
  // Nor does a partial run that shot nothing for one of the paths it was given.
  const failed = result.manifest.stats?.failed ?? 0;
  const unmatched = result.manifest.partial?.unmatched ?? [];
  if (unmatched.length) {
    log(
      `⚠ --only matched no page for ${unmatched.join(", ")}: nothing was shot for it. Check the path against the routes file; a page that is new needs a crawl without --replay, or a "- <path>" line there`,
    );
  }
  if (source && result.manifest.stats?.complete) {
    const record = sameSource(intent.source, source) ? intent.source : source;
    await writeRoutesFile(config, inputManifest, intent, baseUrl, () => {}, record);
  } else if (source && config.routesFile !== false) {
    log(
      `routes file: commit record left as it was — ${opts.pagesOnly ? "this run skipped the UI states" : failed ? `${failed} shot(s) failed` : "--only named a page that wasn't shot"}`,
    );
  }
  return result;
}

/**
 * Do two records describe the same code, shot the same way? Capture time aside. With
 * uncommitted changes, the same files must have been dirty (`dirtyHash`): the same
 * count can be other files, and `changes` reads which from the run the record names.
 */
export function sameSource(a: SourceInfo | undefined, b: SourceInfo): boolean {
  return (
    !!a &&
    a.commit === b.commit &&
    a.branch === b.branch &&
    a.dirty === b.dirty &&
    a.dirtyHash === b.dirtyHash &&
    a.target === b.target &&
    a.config === b.config
  );
}

/**
 * Everything a crawl does before it captures: discover (or replay) the site model,
 * cache it and rewrite the routes file. `crawl --dry-run` stops here and reports
 * what the capture would take.
 */
export async function planCrawl(opts: CrawlPipelineOptions): Promise<CrawlPlan> {
  const log = opts.log ?? (() => {});
  const outRoot = path.resolve(opts.config.output.dir);
  return withLock(outRoot, log, true, async () => {
    const { inputManifest, intent, wrote } = await crawlModel(opts, outRoot);
    const config = applyHints(opts.config, inputManifest.hints);
    const model = captureModel(inputManifest, intent, config, !!opts.pagesOnly);
    const names = config.devices.map((d) => d.name);
    const shotsOf = (routes: RouteNode[]) => {
      let n = 0;
      for (const r of routes) {
        for (const s of r.states)
          n += s.devices ? names.filter((d) => s.devices!.includes(d)).length : names.length;
      }
      return n;
    };
    let partial: CrawlPlan["partial"];
    let shooting = model.routes;
    if (opts.only?.length) {
      const site = siteDir(outRoot, siteKey(opts.baseUrl, config.output.site));
      const source = await findCarrySource(site);
      const plan = source
        ? await verifyCarry(
            planCarry(model.routes, opts.only, source.manifest, config.devices),
            source,
            config.devices,
          )
        : undefined;
      if (plan) shooting = plan.capture;
      partial = {
        only: opts.only,
        carriedFrom: source?.runId,
        capture: shooting.map((r) => r.url),
        carry: plan?.carry.map((r) => r.url) ?? [],
        forced: plan?.forced ?? [],
        carriedShots: plan ? shotsOf(plan.carry) : 0,
      };
    }
    return {
      cachePath: modelCachePath(outRoot),
      routes: model.routes.map((r) => ({ url: r.url, states: r.states.map((s) => s.id) })),
      states: model.routes.reduce((n, r) => n + r.states.length, 0),
      shots: shotsOf(shooting),
      devices: names,
      ...(partial ? { partial } : {}),
      ...(wrote?.length ? { wrote } : {}),
    };
  });
}

async function crawlModel(
  opts: CrawlPipelineOptions,
  outRoot: string,
): Promise<{
  inputManifest: InputManifest;
  intent: RoutesIntent;
  storageState?: string;
  quiet?: QuietTrigger[];
  wrote?: WroteTrigger[];
}> {
  const { config, baseUrl, replay } = opts;
  const log = opts.log ?? (() => {});
  const cachePath = modelCachePath(outRoot);
  const keepStates = !!opts.pagesOnly;

  const prepared = await prepareModel(config, baseUrl, cachePath, log, onlyPages(opts.only));
  const { intent, seeded, storageState, cached } = prepared;
  const effectiveConfig = keepStates
    ? withoutStates(prepared.effectiveConfig)
    : prepared.effectiveConfig;
  let inputManifest: InputManifest;
  let quiet: QuietTrigger[] | undefined;
  let wrote: WroteTrigger[] | undefined;
  if (replay && cached) {
    log(`replay: reusing cached site model → ${cachePath}`);
    inputManifest = cached;
    // Pages added to the routes file since the last discovery: map just those, so
    // a replay doesn't silently skip them. With --only, the pages it names are mapped
    // again too: a page that changed may have states the cache doesn't know yet.
    const added = unmappedRoutes(cached, seeded);
    const changed = opts.only?.length
      ? cached.routes.filter((r) => matchesOnly(r, opts.only!)).map((r) => r.url)
      : [];
    // Known pages first, in the model's order, then the new ones: a site-wide state
    // stays with the page that had it, whichever run maps it.
    const visit = [...new Set([...changed, ...added])];
    if (visit.length) {
      log(
        `replay: discovering ${visit.length} page(s)` +
          (changed.length
            ? ` (${changed.length} named by --only, ${added.length} new)`
            : " new in the routes file"),
      );
      const remapped = new Set(changed);
      const {
        quiet: noted,
        wrote: wrote1,
        ...found
      } = await discoverPipeline({
        config: applyHints(effectiveConfig, cached.hints),
        baseUrl,
        storageState,
        log,
        limit: {
          only: visit,
          takenIds: cached.routes.filter((r) => !remapped.has(r.url)).map((r) => r.id),
        },
        existing: cached,
      });
      quiet = noted;
      wrote = wrote1;
      keepRouteIds(found.routes, cached.routes);
      found.routes = dropMissingSeeds(found.routes, opts.only, intent, cached, log);
      inputManifest = {
        ...mergeManifests(cached, found, { keepStates }),
        site: cached.site ?? found.site,
      };
      await saveJson(cachePath, inputManifest);
    }
  } else {
    ({
      model: inputManifest,
      quiet,
      wrote,
    } = await rediscover(
      effectiveConfig,
      baseUrl,
      storageState,
      cached,
      cachePath,
      log,
      keepStates,
    ));
    const kept = dropMissingSeeds(inputManifest.routes, opts.only, intent, cached, log);
    if (kept.length !== inputManifest.routes.length) {
      inputManifest = { ...inputManifest, routes: kept };
      await saveJson(cachePath, inputManifest);
    }
  }

  await writeRoutesFile(config, inputManifest, intent, baseUrl, log);
  return { inputManifest, intent, storageState, quiet, wrote };
}

/**
 * Leave out a page that only `--only` named (not in the routes file, not mapped
 * before) when it answered with an error: a mistyped path isn't a page to catalogue.
 */
function dropMissingSeeds(
  routes: RouteNode[],
  only: string[] | undefined,
  intent: RoutesIntent,
  cached: InputManifest | undefined,
  log: Log,
): RouteNode[] {
  const seeds = onlyPages(only).filter(
    (p) => !intent.routes.some((r) => r.path === p) && !cached?.routes.some((r) => r.url === p),
  );
  if (!seeds.length) return routes;
  return routes.filter((r) => {
    if (!seeds.includes(r.url) || r.status === undefined || r.status < 400) return true;
    log(`⚠ --only ${r.url}: the page answered ${r.status}, so it isn't added to the catalogue`);
    return false;
  });
}

/** The config for a pages-only discovery: routes, no state probing. */
function withoutStates(config: Config): Config {
  return {
    ...config,
    discovery: {
      ...config.discovery,
      interactions: { ...config.discovery.interactions, auto: false },
    },
  };
}

/**
 * A page rediscovered by name keeps the id it had: shot folders and tile ids are
 * built from it, and a compare between runs matches shots by them.
 */
function keepRouteIds(found: RouteNode[], cached: RouteNode[]): void {
  const ids = new Map(cached.map((r) => [r.url, r.id]));
  for (const r of found) {
    const id = ids.get(r.url);
    if (id) r.id = id;
  }
}

/**
 * The plain paths among `--only` patterns (no globs), as paths: pages to seed
 * discovery with. A full URL is reduced to its path.
 */
export function onlyPages(only: string[] | undefined): string[] {
  const out: string[] = [];
  for (const p of only ?? []) {
    if (p.includes("*")) continue;
    if (p.startsWith("/")) out.push(p);
    else if (/^https?:/.test(p)) {
      try {
        const u = new URL(p);
        out.push(u.pathname + u.search);
      } catch {
        // not a URL after all: nothing to seed
      }
    }
  }
  return [...new Set(out)];
}

/** What every model-building run starts from: routes-file intent, session, cache. */
async function prepareModel(
  config: Config,
  baseUrl: string,
  cachePath: string,
  log: Log,
  extraPages: string[] = [],
) {
  // Routes-file intent: listed routes seed discovery, skip: globs exclude. Pages
  // named on the command line (--only) seed it too, so a new one gets mapped, but only
  // in `seeded`: a one-off filter (or a typo in one) isn't written into the routes file.
  const intent = await loadRoutesIntent(config);
  const seeded: RoutesIntent = {
    ...intent,
    routes: [
      ...intent.routes,
      ...extraPages
        .filter((page) => !intent.routes.some((r) => r.path === page))
        .map((page) => ({ path: page, states: [] })),
    ],
  };
  const intentOrigin = intent.target ? safeOrigin(intent.target) : undefined;
  if (intentOrigin && intentOrigin !== safeOrigin(baseUrl)) {
    log(`⚠ routes file targets ${intent.target} but crawling ${baseUrl} — regenerating for it`);
  }
  for (const w of intent.warnings) log(`⚠ routes file: ${w}`);
  const effectiveConfig = applyRoutesIntent(config, seeded);
  const storageState = await ensureStorageState(config, log, baseUrl);
  const cached = (await pathExists(cachePath)) ? await loadInputManifest(cachePath) : undefined;
  return { intent, seeded, effectiveConfig, storageState, cached };
}

/** Discover the site from scratch and fold it into the cache, which it then saves. */
async function rediscover(
  config: Config,
  baseUrl: string,
  storageState: string | undefined,
  cached: InputManifest | undefined,
  cachePath: string,
  log: Log,
  keepStates = false,
): Promise<{ model: InputManifest; quiet?: QuietTrigger[]; wrote?: WroteTrigger[] }> {
  // Hints cached from earlier runs steer discovery too (skipTriggers), so read
  // them before probing rather than only on the way into capture.
  // What it noticed about this run only stays out of the cached model.
  const { quiet, wrote, ...discovered } = await discoverPipeline({
    config: applyHints(config, cached?.hints),
    baseUrl,
    storageState,
    log,
    limit: { known: cached?.routes.map((r) => r.url) },
  });
  let model: InputManifest;
  // Discovery MERGES into any existing cache rather than overwriting it — auto
  // states are refreshed, authored (hand-written / Explore-mode) states and hints
  // are always preserved.
  if (cached) {
    model = mergeManifests(cached, discovered, { keepStates });
    const authored = model.routes.reduce((n, r) => n + r.states.filter(isAuthored).length, 0);
    log(
      `merged discovery into existing cache → ${cachePath} (${authored} authored state(s) preserved)`,
    );
  } else {
    model = discovered;
    log(`cached site model → ${cachePath}`);
  }
  await saveJson(cachePath, model); // shots-free model, cached for reuse
  return { model, quiet, wrote };
}

/**
 * Discovery only (`visualice discover`): the same login, hints and cache merge as a
 * crawl's discovery, without capturing anything.
 */
export async function discoverOnlyPipeline(opts: {
  config: Config;
  baseUrl: string;
  /** Routes only: no state probing, and the states already cached are kept. */
  pagesOnly?: boolean;
  log?: Log;
}): Promise<{ inputManifest: InputManifest; cachePath: string }> {
  const { config, baseUrl } = opts;
  const keepStates = !!opts.pagesOnly;
  const log = opts.log ?? (() => {});
  const outRoot = path.resolve(config.output.dir);
  const cachePath = modelCachePath(outRoot);
  return withLock(outRoot, log, true, async () => {
    const { intent, effectiveConfig, storageState, cached } = await prepareModel(
      config,
      baseUrl,
      cachePath,
      log,
    );
    const { model: inputManifest } = await rediscover(
      keepStates ? withoutStates(effectiveConfig) : effectiveConfig,
      baseUrl,
      storageState,
      cached,
      cachePath,
      log,
      keepStates,
    );
    await writeRoutesFile(config, inputManifest, intent, baseUrl, log);
    return { inputManifest, cachePath };
  });
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * Which pages the site has now against the ones the cached model knows, from a
 * route-only discovery (no states, nothing written): `changes --discover`.
 */
export async function previewRoutes(opts: {
  config: Config;
  baseUrl: string;
  log?: Log;
}): Promise<{ added: string[]; removed: string[]; capped: boolean }> {
  const { config, baseUrl } = opts;
  const log = opts.log ?? (() => {});
  const outRoot = path.resolve(config.output.dir);
  const cachePath = modelCachePath(outRoot);
  return withLock(outRoot, log, true, async () => {
    const { effectiveConfig, storageState, cached, intent } = await prepareModel(
      config,
      baseUrl,
      cachePath,
      log,
    );
    const found = await discoverPipeline({
      config: applyHints(withoutStates(effectiveConfig), cached?.hints),
      baseUrl,
      storageState,
      log,
      limit: { known: cached?.routes.map((r) => r.url) },
    });
    // Every known page is a seed, so a deleted one is still visited: it is gone when
    // the site answers that it is (404, 410…). One discovery never reached is gone
    // too, unless it stopped at scope.maxPages: a page it didn't get to isn't gone.
    const dead = new Set(
      found.routes.filter((r) => r.status !== undefined && r.status >= 400).map((r) => r.url),
    );
    const seen = new Set(found.routes.map((r) => r.url));
    const known = (cached?.routes ?? []).filter((r) => !routeMatches(r.url, intent.skipRoutes));
    const before = new Set(known.map((r) => r.url));
    const capped = found.routes.length >= config.scope.maxPages;
    return {
      added: [...seen].filter((u) => !before.has(u) && !dead.has(u)),
      removed: [...before].filter((u) => dead.has(u) || (!capped && !seen.has(u))),
      capped,
    };
  });
}

/** Where a partial run keeps what `--only` named, so `--resume` continues it as one. */
const PARTIAL_PLAN = "partial.json";

async function savePartialPlan(runDir: string, only: string[]): Promise<void> {
  await fs.writeFile(path.join(runDir, PARTIAL_PLAN), JSON.stringify({ only }));
}

export async function readPartialPlan(runDir: string): Promise<string[] | undefined> {
  try {
    const { only } = JSON.parse(await fs.readFile(path.join(runDir, PARTIAL_PLAN), "utf8")) as {
      only?: unknown;
    };
    return Array.isArray(only) && only.every((o) => typeof o === "string") && only.length
      ? only
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A shot that couldn't be carried is missing from the run like a failed capture, and
 * counts as one: in `failed` (so `--fail-on-error` exits 3), in the report and in
 * `failures` with `--json`.
 */
export function countCarryFailures(
  stats: Pick<NonNullable<Manifest["stats"]>, "failed" | "failures">,
  carried: RouteNode[],
): void {
  for (const route of carried) {
    for (const state of route.states) {
      for (const [device, ref] of Object.entries(state.shots)) {
        if (!ref.error) continue;
        stats.failed++;
        stats.failures.push({ route: route.url, state: state.id, device, error: ref.error });
      }
    }
  }
}
