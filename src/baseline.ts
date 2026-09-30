import path from "node:path";
import { promises as fs } from "node:fs";
import type { Config } from "./shared/config";
import type { Device, Manifest, RouteNode } from "./shared/types";
import { loadManifest, saveJson } from "./crawl/manifest";
import { pathExists } from "./shared/fsx";
import { matchesAny } from "./shared/glob";
import { pathSlug, stateSlug } from "./shared/slug";

/**
 * The approved baseline: the shots a new run is held against.
 *
 * Comparing a run with the one before it answers "what did my last change do?",
 * but it can't gate a pipeline — once a change is intended, the next run differs
 * from its predecessor in exactly the way it should, and again from the one after.
 * A baseline is the fix: a copy of a run that someone looked at and accepted, kept
 * outside `runs/` so pruning never takes it, and replaced only by `visualice
 * approve`. It is shaped like a run directory (`crawl-map.json` + `screenshots/`),
 * so everything that reads a run can read it.
 */

export interface BaselineInfo {
  /** The run the baseline was last approved from. */
  runId: string;
  approvedAt: string;
  /** Path globs of the last approval when it covered only part of the site. */
  routes?: string[];
}

export function baselineDir(config: Config): string {
  return path.resolve(config.baseline.dir ?? path.join(config.output.dir, "baseline"));
}

export async function hasBaseline(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, "crawl-map.json"));
}

export async function readBaselineInfo(dir: string): Promise<BaselineInfo | undefined> {
  const raw = await fs.readFile(path.join(dir, "baseline.json"), "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as BaselineInfo;
  } catch {
    return undefined;
  }
}

function routePath(url: string): string {
  try {
    return new URL(url, "http://_local_").pathname;
  } catch {
    return url;
  }
}

/** Routes keep their identity across runs by slug, the same key a diff pairs on. */
const keyOf = (route: RouteNode): string => pathSlug(route.url);

/**
 * Merge the approved routes of `run` into `baseline`, as pure data.
 *
 * A route the globs match is taken from the run as it stands — added, replaced, or
 * (when the run no longer has it) dropped, because approving a run in which a page
 * is gone is approving that it's gone. Every other route is left exactly as it was.
 */
export function mergeApproved(
  baseline: Manifest,
  run: Manifest,
  globs: string[],
): { manifest: Manifest; replaced: RouteNode[]; dropped: RouteNode[] } {
  const matches = (route: RouteNode) => matchesAny(routePath(route.url), globs);
  const incoming = new Map(run.routes.filter(matches).map((r) => [keyOf(r), r]));
  const replaced: RouteNode[] = [];
  const dropped: RouteNode[] = [];

  const routes: RouteNode[] = [];
  for (const route of baseline.routes) {
    if (!matches(route)) {
      routes.push(route);
      continue;
    }
    const next = incoming.get(keyOf(route));
    if (next) {
      routes.push(next);
      replaced.push(route);
      incoming.delete(keyOf(route));
    } else {
      dropped.push(route);
    }
  }
  routes.push(...incoming.values());

  // A partial approval can introduce a device the baseline hadn't seen.
  const devices = new Map<string, Device>(baseline.devices.map((d) => [d.name, d]));
  for (const d of run.devices) devices.set(d.name, d);

  return {
    manifest: { ...baseline, devices: [...devices.values()], routes },
    replaced,
    dropped,
  };
}

const stateDirOf = (root: string, route: RouteNode, stateId: string): string =>
  path.join(root, "screenshots", pathSlug(route.url), stateSlug(stateId));

export interface ApproveOptions {
  runDir: string;
  baselineDir: string;
  /** Approve only the routes these path globs match; omit for the whole run. */
  routes?: string[];
  log?: (msg: string) => void;
}

export interface ApproveResult {
  runId: string;
  baselineDir: string;
  routes: number;
  shots: number;
  partial: boolean;
}

const countShots = (routes: RouteNode[]): number =>
  routes.reduce(
    (n, r) =>
      n + r.states.reduce((m, s) => m + Object.values(s.shots).filter((x) => x.full).length, 0),
    0,
  );

/** Make `runDir` (or the part of it the globs match) the approved baseline. */
export async function approveRun(opts: ApproveOptions): Promise<ApproveResult> {
  const log = opts.log ?? (() => {});
  const run = await loadManifest(path.join(opts.runDir, "crawl-map.json")).catch(() => undefined);
  if (!run) throw new Error(`no run manifest at ${opts.runDir}/crawl-map.json`);
  if (run.stats?.failed) {
    log(`⚠ this run has ${run.stats.failed} failed capture(s) — they are approved as failures`);
  }

  const dir = opts.baselineDir;
  const existing = (await hasBaseline(dir))
    ? await loadManifest(path.join(dir, "crawl-map.json"))
    : undefined;
  const partial = opts.routes !== undefined && existing !== undefined;

  let manifest: Manifest;
  let approved: RouteNode[];
  if (partial) {
    const merged = mergeApproved(existing, run, opts.routes!);
    manifest = merged.manifest;
    approved = run.routes.filter((r) => matchesAny(routePath(r.url), opts.routes!));
    // Only the states' own directories go: a route's folder can also hold the
    // folders of the routes nested under its path.
    for (const route of [...merged.replaced, ...merged.dropped]) {
      for (const state of route.states) {
        await fs.rm(stateDirOf(dir, route, state.id), { recursive: true, force: true });
      }
    }
    for (const route of approved) {
      for (const state of route.states) {
        const from = stateDirOf(opts.runDir, route, state.id);
        if (!(await pathExists(from))) continue;
        await fs.cp(from, stateDirOf(dir, route, state.id), { recursive: true });
      }
    }
  } else {
    // With no baseline to merge into, a partial approval starts one from just the
    // matching routes rather than quietly approving everything.
    approved = opts.routes
      ? run.routes.filter((r) => matchesAny(routePath(r.url), opts.routes!))
      : run.routes;
    manifest = { ...run, routes: approved };
    await fs.rm(path.join(dir, "screenshots"), { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    if (opts.routes) {
      for (const route of approved) {
        for (const state of route.states) {
          const from = stateDirOf(opts.runDir, route, state.id);
          if (!(await pathExists(from))) continue;
          await fs.cp(from, stateDirOf(dir, route, state.id), { recursive: true });
        }
      }
    } else if (await pathExists(path.join(opts.runDir, "screenshots"))) {
      await fs.cp(path.join(opts.runDir, "screenshots"), path.join(dir, "screenshots"), {
        recursive: true,
      });
    }
  }

  await saveJson(path.join(dir, "crawl-map.json"), manifest);
  const info: BaselineInfo = {
    runId: run.site.runId,
    approvedAt: new Date().toISOString(),
    ...(opts.routes ? { routes: opts.routes } : {}),
  };
  await saveJson(path.join(dir, "baseline.json"), info);

  return {
    runId: run.site.runId,
    baselineDir: dir,
    routes: approved.length,
    shots: countShots(approved),
    partial: opts.routes !== undefined,
  };
}
