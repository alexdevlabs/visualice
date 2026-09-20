import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";
import type { Manifest, InputManifest, ViewerData, ViewerTile } from "../shared/types";
import { runCapture } from "./capture";
import { renderReport } from "./report";
import { saveJson, mergeManifests, loadInputManifest } from "./manifest";
import { discoverPipeline } from "./discover";
import { ensureStorageState } from "./auth";
import {
  applyRoutesIntent,
  applyStateSkips,
  computeWanted,
  loadRoutesIntent,
  writeRoutesFile,
  type RoutesIntent,
} from "./routes-file";
import { pathExists } from "../shared/fsx";
import { pathSlug } from "../shared/slug";

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
  log?: (msg: string) => void;
}

export interface CapturePipelineResult {
  runDir: string;
  manifest: Manifest;
}

function toViewerData(m: Manifest): ViewerData {
  const tiles: ViewerTile[] = [];
  for (const r of m.routes) {
    const routePath = pathSlug(r.url);
    for (const s of r.states) {
      for (const [device, ref] of Object.entries(s.shots)) {
        if (!ref.full) continue;
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
          width: ref.width,
          height: ref.height,
        });
      }
    }
  }
  return {
    site: m.site,
    devices: m.devices,
    tiles,
    groups: m.routes.map((r) => ({ path: pathSlug(r.url), routeId: r.id, title: r.title })),
  };
}

async function updateLatest(outRoot: string, id: string): Promise<void> {
  const link = path.join(outRoot, "runs", "latest");
  await fs.rm(link, { force: true }).catch(() => {});
  await fs.symlink(id, link, "dir").catch(() => {});
}

async function pruneRuns(outRoot: string, keep: number): Promise<void> {
  const runsDir = path.join(outRoot, "runs");
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name !== "latest")
    .map((e) => e.name)
    .sort();
  for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    await fs.rm(path.join(runsDir, d), { recursive: true, force: true }).catch(() => {});
  }
}

/** Capture-only pipeline (M1): replay a manifest's recipes across all devices. */
export async function capturePipeline(
  opts: CapturePipelineOptions,
): Promise<CapturePipelineResult> {
  const { config, baseUrl } = opts;
  const log = opts.log ?? (() => {});
  const id = makeRunId();
  const origin = new URL(baseUrl).origin;
  const outRoot = path.resolve(config.output.dir);
  const runDir = path.join(outRoot, "runs", id);
  await fs.mkdir(runDir, { recursive: true });

  // The routes file subtracts (skip:) before capture, and its unmet requests
  // ([ ] lines) surface as `wanted` — the Explore-mode queue.
  const intent = opts.routesIntent ?? (await loadRoutesIntent(config));
  const inputManifest = applyStateSkips(opts.inputManifest, intent);
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
    configSnapshot: config,
    devices: config.devices,
    auth: inputManifest.auth,
    routes: inputManifest.routes,
    hints: inputManifest.hints,
  };

  const storageState = opts.storageState ?? (await ensureStorageState(config, log));

  const result = await runCapture({ config, manifest, baseUrl, runDir, storageState, log });

  if (result.manifest.stats && wanted.length) {
    result.manifest.stats.wanted = wanted;
    log(`${wanted.length} wanted state(s) still need authoring (see routes file / report)`);
  }

  await saveJson(path.join(runDir, "crawl-map.json"), result.manifest);
  await saveJson(path.join(runDir, "viewer-data.json"), toViewerData(result.manifest));
  await fs.writeFile(path.join(runDir, "crawl-report.md"), renderReport(result.manifest));

  await updateLatest(outRoot, id);
  await pruneRuns(outRoot, config.output.keepRuns);

  return { runDir, manifest: result.manifest };
}

export interface CrawlPipelineOptions {
  config: Config;
  baseUrl: string;
  /** Reuse the cached site model (skip discovery) when available. */
  replay?: boolean;
  log?: (msg: string) => void;
}

/**
 * Full pipeline (M2/M3 + M1): discover routes + UI states (or reuse the cached
 * model), then capture every state across all devices. The cached `crawl-map.cache.json`
 * is what makes subsequent `--replay` runs fast and deterministic.
 */
export async function crawlPipeline(opts: CrawlPipelineOptions): Promise<CapturePipelineResult> {
  const { config, baseUrl, replay } = opts;
  const log = opts.log ?? (() => {});
  const outRoot = path.resolve(config.output.dir);
  const cachePath = path.join(outRoot, "crawl-map.cache.json");

  // Routes-file intent: listed routes seed discovery, skip: globs exclude.
  const intent = await loadRoutesIntent(config);
  const intentOrigin = intent.target ? safeOrigin(intent.target) : undefined;
  if (intentOrigin && intentOrigin !== safeOrigin(baseUrl)) {
    log(`⚠ routes file targets ${intent.target} but crawling ${baseUrl} — regenerating for it`);
  }
  for (const w of intent.warnings) log(`⚠ routes file: ${w}`);
  const effectiveConfig = applyRoutesIntent(config, intent);

  const storageState = await ensureStorageState(config, log);

  let inputManifest: InputManifest;
  if (replay && (await pathExists(cachePath))) {
    log(`replay: reusing cached site model → ${cachePath}`);
    inputManifest = await loadInputManifest(cachePath);
  } else {
    const discovered = await discoverPipeline({
      config: effectiveConfig,
      baseUrl,
      storageState,
      log,
    });
    // Default crawl re-discovers from scratch, but MERGES into any existing cache
    // rather than overwriting it — auto states are refreshed, authored (hand-written /
    // Explore-mode) states are always preserved.
    if (await pathExists(cachePath)) {
      const cached = await loadInputManifest(cachePath);
      inputManifest = mergeManifests(cached, discovered);
      const authored = inputManifest.routes.reduce(
        (n, r) => n + r.states.filter((s) => (s.source ?? "authored") !== "auto").length,
        0,
      );
      log(
        `merged discovery into existing cache → ${cachePath} (${authored} authored state(s) preserved)`,
      );
    } else {
      inputManifest = discovered;
      log(`cached site model → ${cachePath}`);
    }
    await saveJson(cachePath, inputManifest); // shots-free model, cached for reuse
  }

  await writeRoutesFile(config, inputManifest, intent, baseUrl, log);

  return capturePipeline({
    config,
    inputManifest,
    baseUrl,
    storageState,
    routesIntent: intent,
    log,
  });
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
