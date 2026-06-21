import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "../shared/config";
import type { Manifest, InputManifest, ViewerData, ViewerTile } from "../shared/types";
import { runCapture } from "./capture";
import { renderReport } from "./report";
import { saveJson } from "./manifest";
import { discoverPipeline } from "./discover";
import { ensureStorageState } from "./auth";
import { pathSlug } from "../shared/slug";

export function makeRunId(date = new Date()): string {
  return date.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
}

export interface CapturePipelineOptions {
  config: Config;
  inputManifest: InputManifest;
  baseUrl: string;
  /** Pre-resolved storageState path; if omitted, auth is resolved from config. */
  storageState?: string;
  log?: (msg: string) => void;
}

export interface CapturePipelineResult {
  runDir: string;
  manifest: Manifest;
}

async function fileExists(p: string): Promise<boolean> {
  return !!(await fs.stat(p).catch(() => null));
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
export async function capturePipeline(opts: CapturePipelineOptions): Promise<CapturePipelineResult> {
  const { config, inputManifest, baseUrl } = opts;
  const log = opts.log ?? (() => {});
  const id = makeRunId();
  const origin = new URL(baseUrl).origin;
  const outRoot = path.resolve(config.output.dir);
  const runDir = path.join(outRoot, "runs", id);
  await fs.mkdir(runDir, { recursive: true });

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

  const storageState = await ensureStorageState(config, log);

  let inputManifest: InputManifest;
  if (replay && (await fileExists(cachePath))) {
    log(`replay: reusing cached site model → ${cachePath}`);
    inputManifest = JSON.parse(await fs.readFile(cachePath, "utf8")) as InputManifest;
  } else {
    inputManifest = await discoverPipeline({ config, baseUrl, storageState, log });
    await saveJson(cachePath, inputManifest); // shots-free model, cached for reuse
    log(`cached site model → ${cachePath}`);
  }

  return capturePipeline({ config, inputManifest, baseUrl, storageState, log });
}
