import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";
import type { Manifest, InputManifest, StateNode, ViewerData, ViewerTile } from "../shared/types";
import { matchesAny } from "../shared/glob";
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
  runDir as runDirFor,
  runIdTime,
  runsToPrune,
} from "./runs";
import { redactConfig } from "../shared/redact";
import { acquireLock } from "../shared/lock";
import { applyHints, describeHints } from "../shared/hints";

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
        });
      }
    }
  }

  return {
    site: m.site,
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

async function updateLatest(outRoot: string, id: string): Promise<void> {
  const link = runDirFor(outRoot, "latest");
  await fs.rm(link, { force: true }).catch(() => {});
  await fs.symlink(id, link, "dir").catch(() => {});
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
async function pruneRuns(outRoot: string, keep: number, current: string, log: Log): Promise<void> {
  // Only runs this tool generated are pruned *or counted*. A hand-named directory
  // (a copied-in baseline, say) is not ours to delete, and letting it occupy a slot
  // in the keep budget would silently push a real run out instead.
  const ids = (await listRuns(outRoot)).filter((id) => runIdTime(id) !== undefined);
  for (const id of runsToPrune(ids, keep, current)) {
    try {
      await fs.rm(runDirFor(outRoot, id), { recursive: true, force: true });
    } catch (e) {
      log(`⚠ could not prune old run ${id}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
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
  const runDir = runDirFor(outRoot, id);
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
  const inputManifest = withComponents(
    applyStateSkips(opts.inputManifest, intent),
    config.components,
  );
  const wanted = computeWanted(opts.inputManifest, intent);

  const manifest: Manifest = {
    version: 1,
    site: {
      baseUrl,
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

  const storageState = opts.storageState ?? (await ensureStorageState(config, log));

  const result = await runCapture({
    config,
    manifest,
    baseUrl,
    runDir,
    storageState,
    resume: opts.resume !== undefined,
    log,
  });

  if (result.manifest.stats && wanted.length) {
    result.manifest.stats.wanted = wanted;
    log(`${wanted.length} wanted state(s) still need authoring (see routes file / report)`);
  }

  await saveJson(path.join(runDir, "crawl-map.json"), result.manifest);
  await saveJson(path.join(runDir, "viewer-data.json"), toViewerData(result.manifest));
  await fs.writeFile(path.join(runDir, "crawl-report.md"), renderReport(result.manifest));

  await markRunComplete(runDir);
  await updateLatest(outRoot, id);
  await pruneRuns(outRoot, config.output.keepRuns, id, log);

  return { runDir, manifest: result.manifest };
}

export interface CrawlPipelineOptions {
  config: Config;
  baseUrl: string;
  /** Reuse the cached site model (skip discovery) when available. */
  replay?: boolean;
  /** Continue the newest unfinished run instead of starting a new one. */
  resume?: boolean;
  log?: (msg: string) => void;
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
  const { config, baseUrl, replay } = opts;
  const log = opts.log ?? (() => {});
  const cachePath = modelCachePath(outRoot);

  let resume: string | undefined;
  if (opts.resume) {
    resume = await findResumableRun(outRoot);
    if (resume) log(`resuming run ${resume}`);
    else log("nothing to resume — starting a new run");
  }

  const { intent, effectiveConfig, storageState, cached } = await prepareModel(
    config,
    baseUrl,
    cachePath,
    log,
  );
  let inputManifest: InputManifest;
  if (replay && cached) {
    log(`replay: reusing cached site model → ${cachePath}`);
    inputManifest = cached;
    // Pages added to the routes file since the last discovery: map just those, so
    // a replay doesn't silently skip them.
    const added = unmappedRoutes(cached, intent);
    if (added.length) {
      log(`replay: discovering ${added.length} page(s) new in the routes file`);
      const found = await discoverPipeline({
        config: applyHints(effectiveConfig, cached.hints),
        baseUrl,
        storageState,
        log,
        limit: { only: added, takenIds: cached.routes.map((r) => r.id) },
        existing: cached,
      });
      inputManifest = { ...mergeManifests(cached, found), site: cached.site ?? found.site };
      await saveJson(cachePath, inputManifest);
    }
  } else {
    inputManifest = await rediscover(
      effectiveConfig,
      baseUrl,
      storageState,
      cached,
      cachePath,
      log,
    );
  }

  await writeRoutesFile(config, inputManifest, intent, baseUrl, log);

  return capturePipeline({
    config,
    inputManifest,
    baseUrl,
    storageState,
    routesIntent: intent,
    lock: false,
    resume,
    log,
  });
}

/** What every model-building run starts from: routes-file intent, session, cache. */
async function prepareModel(config: Config, baseUrl: string, cachePath: string, log: Log) {
  // Routes-file intent: listed routes seed discovery, skip: globs exclude.
  const intent = await loadRoutesIntent(config);
  const intentOrigin = intent.target ? safeOrigin(intent.target) : undefined;
  if (intentOrigin && intentOrigin !== safeOrigin(baseUrl)) {
    log(`⚠ routes file targets ${intent.target} but crawling ${baseUrl} — regenerating for it`);
  }
  for (const w of intent.warnings) log(`⚠ routes file: ${w}`);
  const effectiveConfig = applyRoutesIntent(config, intent);
  const storageState = await ensureStorageState(config, log);
  const cached = (await pathExists(cachePath)) ? await loadInputManifest(cachePath) : undefined;
  return { intent, effectiveConfig, storageState, cached };
}

/** Discover the site from scratch and fold it into the cache, which it then saves. */
async function rediscover(
  config: Config,
  baseUrl: string,
  storageState: string | undefined,
  cached: InputManifest | undefined,
  cachePath: string,
  log: Log,
): Promise<InputManifest> {
  // Hints cached from earlier runs steer discovery too (skipTriggers), so read
  // them before probing rather than only on the way into capture.
  const discovered = await discoverPipeline({
    config: applyHints(config, cached?.hints),
    baseUrl,
    storageState,
    log,
  });
  let model: InputManifest;
  // Discovery MERGES into any existing cache rather than overwriting it — auto
  // states are refreshed, authored (hand-written / Explore-mode) states and hints
  // are always preserved.
  if (cached) {
    model = mergeManifests(cached, discovered);
    const authored = model.routes.reduce((n, r) => n + r.states.filter(isAuthored).length, 0);
    log(
      `merged discovery into existing cache → ${cachePath} (${authored} authored state(s) preserved)`,
    );
  } else {
    model = discovered;
    log(`cached site model → ${cachePath}`);
  }
  await saveJson(cachePath, model); // shots-free model, cached for reuse
  return model;
}

/**
 * Discovery only (`visualice discover`): the same login, hints and cache merge as a
 * crawl's discovery, without capturing anything.
 */
export async function discoverOnlyPipeline(opts: {
  config: Config;
  baseUrl: string;
  log?: Log;
}): Promise<{ inputManifest: InputManifest; cachePath: string }> {
  const { config, baseUrl } = opts;
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
    const inputManifest = await rediscover(
      effectiveConfig,
      baseUrl,
      storageState,
      cached,
      cachePath,
      log,
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
