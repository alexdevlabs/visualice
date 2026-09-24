import path from "node:path";
import { promises as fs } from "node:fs";
import type { Manifest } from "../shared/types";
import { loadManifest as readManifest } from "../crawl/manifest";
import { pairShots, routeDelta, type ShotPair } from "./compare";
import { compareImages, writeDiffImage } from "./pixels";
import { renderDiffReport } from "./report";
import { mapPool } from "../shared/pool";
import type { RunDiff, ShotDiff } from "./types";

export interface DiffOptions {
  fromDir: string;
  toDir: string;
  /** Where to write diff-report.md + images/. Omit to compare without writing images. */
  outDir?: string;
  /** Per-channel tolerance passed to the pixel comparison. */
  threshold?: number;
  /**
   * Noise floor: a pair is changed only when more than this fraction of its pixels
   * differ, or more than this fraction of the page was gained or lost to a size
   * change. Default 0 — any difference at all.
   */
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

type Size = { width: number; height: number };

/**
 * The share of the larger shot that the other one doesn't cover — the area a size
 * change added or removed. 0 when the two are the same size.
 */
export function sizeRatio(from: Size, to: Size): number {
  const overlap = Math.min(from.width, to.width) * Math.min(from.height, to.height);
  const larger = Math.max(from.width * from.height, to.width * to.height);
  return larger > 0 ? 1 - overlap / larger : 0;
}

/**
 * Does a compared pair count as changed?
 *
 * Two kinds of difference, one noise floor. The overlap's changed pixels are one;
 * the area only one shot has is the other, and it matters — a page that lost its
 * footer has an identical overlap and is still broken. But it is held to `minRatio`
 * like the pixels are: counting *any* size change as a change let a page that grew
 * by a pixel (a lazy image, a rotating testimonial) fail `--fail-on-error` with
 * nothing `--min-ratio` could do about it.
 */
export function isChanged(cmp: { ratio: number; from: Size; to: Size }, minRatio: number): boolean {
  return cmp.ratio > minRatio || sizeRatio(cmp.from, cmp.to) > minRatio;
}

/** The identity + shot paths every result row carries, whatever its outcome. */
function baseDiff(pair: ShotPair): Omit<ShotDiff, "status"> {
  return {
    key: pair.key,
    route: pair.route,
    routeUrl: pair.routeUrl,
    state: pair.state,
    stateLabel: pair.stateLabel,
    device: pair.device,
    fromShot: pair.from?.full,
    toShot: pair.to?.full,
  };
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
    results[i] = { ...baseDiff(pair), status: pair.status, note: pair.note };
  });

  const indexed = pairs
    .map((pair, i) => ({ pair, i }))
    .filter(({ pair }) => pair.status === "both");

  await mapPool(indexed, opts.concurrency ?? 4, async ({ pair, i }) => {
    const base = baseDiff(pair);
    const rel = imageRelPath(pair);
    try {
      const cmp = await compareImages(
        path.join(opts.fromDir, pair.from!.full!),
        path.join(opts.toDir, pair.to!.full!),
        { threshold: opts.threshold, renderDiff: opts.outDir !== undefined },
      );
      const changed = isChanged(cmp, minRatio);
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
        sizeRatio: cmp.sizeChanged ? sizeRatio(cmp.from, cmp.to) : undefined,
        fromSize: cmp.from,
        toSize: cmp.to,
        image: opts.outDir && changed ? rel : undefined,
      };
      if (changed) log(`  ~ ${pair.route} / ${pair.state} [${pair.device}]`);
    } catch (e) {
      results[i] = { ...base, status: "uncomparable", note: (e as Error).message.split("\n")[0] };
    }
  });

  const summary: RunDiff["summary"] = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
    uncomparable: 0,
  };
  for (const r of results) summary[r.status]++;

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

export type { RunDiff, ShotDiff, ShotStatus } from "./types";
export { pairShots, routeDelta } from "./compare";
export { compareImages } from "./pixels";
export { renderDiffReport } from "./report";
