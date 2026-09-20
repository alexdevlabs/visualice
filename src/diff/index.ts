import path from "node:path";
import { promises as fs } from "node:fs";
import type { Manifest } from "../shared/types";
import { loadManifest as readManifest } from "../crawl/manifest";
import { pairShots, routeDelta, type ShotPair } from "./compare";
import { compareImages, writeDiffImage } from "./pixels";
import { renderDiffReport } from "./report";
import { mapPool } from "../shared/pool";

export type ShotStatus = "added" | "removed" | "changed" | "unchanged" | "uncomparable";

export interface ShotDiff {
  key: string;
  route: string;
  state: string;
  stateLabel: string;
  device: string;
  status: ShotStatus;
  /** Fraction of compared pixels that differ (0–1), for a compared pair. */
  ratio?: number;
  changedPixels?: number;
  comparedPixels?: number;
  /** Set when the two shots have different dimensions. */
  sizeChanged?: boolean;
  fromSize?: { width: number; height: number };
  toSize?: { width: number; height: number };
  /** Diff image, relative to the diff directory. */
  image?: string;
  note?: string;
}

export interface RunDiff {
  from: { runId: string; dir: string };
  to: { runId: string; dir: string };
  /** Ratio at or above which a pair counts as changed. */
  minRatio: number;
  routes: { added: string[]; removed: string[] };
  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    uncomparable: number;
  };
  shots: ShotDiff[];
  /** Where the report and diff images were written (absent for a dry comparison). */
  outDir?: string;
}

export interface DiffOptions {
  fromDir: string;
  toDir: string;
  /** Where to write diff-report.md + images/. Omit to compare without writing images. */
  outDir?: string;
  /** Per-channel tolerance passed to the pixel comparison. */
  threshold?: number;
  /** Below this fraction of changed pixels a pair is reported as unchanged. Default 0. */
  minRatio?: number;
  concurrency?: number;
  log?: (msg: string) => void;
}

async function loadManifest(runDir: string): Promise<Manifest> {
  const file = path.join(runDir, "crawl-map.json");
  const m = await readManifest(file).catch(() => undefined);
  if (!m) throw new Error(`no run manifest at ${file}`);
  return m;
}

/** Mirror the screenshot layout inside the diff dir: images/<route>/<state>/<device>.png */
function imageRelPath(pair: ShotPair): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "_";
  return path.posix.join("images", safe(pair.route), safe(pair.state), `${safe(pair.device)}.png`);
}

/**
 * Compare two runs shot by shot. Pairing is exact (route|state|device), so a renamed
 * route reads as one removal plus one addition rather than a misleading pixel diff.
 */
export async function diffRuns(opts: DiffOptions): Promise<RunDiff> {
  const log = opts.log ?? (() => {});
  const minRatio = opts.minRatio ?? 0;
  const [from, to] = await Promise.all([loadManifest(opts.fromDir), loadManifest(opts.toDir)]);
  const pairs = pairShots(from, to);

  const results: ShotDiff[] = new Array(pairs.length);
  const comparable = pairs.filter((p) => p.status === "both");
  log(
    `comparing ${comparable.length} shot(s) — ${pairs.length - comparable.length} added/removed/uncomparable`,
  );

  // Non-pixel outcomes first: they need no I/O.
  pairs.forEach((pair, i) => {
    if (pair.status === "both") return;
    results[i] = {
      key: pair.key,
      route: pair.route,
      state: pair.state,
      stateLabel: pair.stateLabel,
      device: pair.device,
      status: pair.status === "uncomparable" ? "uncomparable" : pair.status,
      note: pair.note,
    };
  });

  const indexed = pairs
    .map((pair, i) => ({ pair, i }))
    .filter(({ pair }) => pair.status === "both");

  await mapPool(indexed, opts.concurrency ?? 4, async ({ pair, i }) => {
    const base: ShotDiff = {
      key: pair.key,
      route: pair.route,
      state: pair.state,
      stateLabel: pair.stateLabel,
      device: pair.device,
      status: "unchanged",
    };
    const rel = imageRelPath(pair);
    try {
      const cmp = await compareImages(
        path.join(opts.fromDir, pair.from!.full!),
        path.join(opts.toDir, pair.to!.full!),
        { threshold: opts.threshold, renderDiff: opts.outDir !== undefined },
      );
      const changed = cmp.ratio > minRatio || cmp.sizeChanged;
      // An unchanged pair's diff image is a flat grey rectangle — only the changed
      // ones are worth a file (and a directory) on disk.
      if (changed && cmp.diff && opts.outDir) {
        await writeDiffImage(cmp.diff, path.join(opts.outDir, rel));
      }
      results[i] = {
        ...base,
        status: changed ? "changed" : "unchanged",
        ratio: cmp.ratio,
        changedPixels: cmp.changedPixels,
        comparedPixels: cmp.comparedPixels,
        sizeChanged: cmp.sizeChanged || undefined,
        fromSize: cmp.from,
        toSize: cmp.to,
        image: opts.outDir && changed ? rel : undefined,
      };
      if (changed) log(`  ~ ${pair.route} / ${pair.state} [${pair.device}]`);
    } catch (e) {
      results[i] = { ...base, status: "uncomparable", note: (e as Error).message.split("\n")[0] };
    }
  });

  const summary = {
    added: results.filter((r) => r.status === "added").length,
    removed: results.filter((r) => r.status === "removed").length,
    changed: results.filter((r) => r.status === "changed").length,
    unchanged: results.filter((r) => r.status === "unchanged").length,
    uncomparable: results.filter((r) => r.status === "uncomparable").length,
  };

  const diff: RunDiff = {
    from: { runId: from.site.runId, dir: opts.fromDir },
    to: { runId: to.site.runId, dir: opts.toDir },
    minRatio,
    routes: routeDelta(from, to),
    summary,
    shots: results,
    outDir: opts.outDir,
  };

  if (opts.outDir) {
    await fs.mkdir(opts.outDir, { recursive: true });
    await fs.writeFile(path.join(opts.outDir, "diff-report.md"), renderDiffReport(diff));
    await fs.writeFile(
      path.join(opts.outDir, "diff.json"),
      JSON.stringify(diff, null, 2) + "\n",
      "utf8",
    );
  }
  return diff;
}

export { pairShots, routeDelta } from "./compare";
export { compareImages } from "./pixels";
export { renderDiffReport } from "./report";
