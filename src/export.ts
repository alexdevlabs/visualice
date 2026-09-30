import path from "node:path";
import { promises as fs } from "node:fs";
import { pathExists } from "./shared/fsx";
import { listDiffs } from "./crawl/runs";
import type { RunDiff } from "./diff/types";

/**
 * A self-contained copy of the viewer and one run, for somewhere `visualice serve`
 * isn't: a CI artifact, a static host, a folder handed to a reviewer.
 *
 * The layout is the one `serve` presents over HTTP, written to disk — the viewer
 * only ever asks for relative URLs, so any static file server can stand in:
 *
 *   index.html, assets/   the built viewer
 *   data/                 the run
 *   runs.json, diffs.json the (one-entry) run list and the exported comparisons
 *   diffs/<id>/           each comparison's report and diff images
 *   runs/<id>/, baseline/ only the shots those comparisons point at
 */

export interface ExportOptions {
  runDir: string;
  runId: string;
  viewerDist: string;
  outRoot: string;
  baselineDir: string;
  dest: string;
  /** Comparison ids to include; default is every comparison made against this run. */
  diffs?: string[];
  log?: (msg: string) => void;
}

export interface ExportResult {
  dest: string;
  runId: string;
  diffs: string[];
  files: number;
}

async function copyFile(from: string, to: string): Promise<boolean> {
  if (!(await pathExists(from))) return false;
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  return true;
}

async function countFiles(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).length;
}

export async function exportRun(opts: ExportOptions): Promise<ExportResult> {
  const log = opts.log ?? (() => {});
  const dest = path.resolve(opts.dest);
  // Is `dest` at or under `p`? (An absolute result means another drive on Windows.)
  const inside = (p: string) => {
    const rel = path.relative(path.resolve(p), dest);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  if (inside(opts.runDir) || inside(opts.viewerDist)) {
    throw new Error(`refusing to export into its own source (${dest})`);
  }
  if (await pathExists(dest)) {
    const entries = await fs.readdir(dest);
    // Only ever clear a directory this command wrote: anything else is someone's.
    if (entries.length && !entries.includes(".visualice-export")) {
      throw new Error(`${dest} is not empty and isn't a previous export — pick another directory`);
    }
    await fs.rm(dest, { recursive: true, force: true });
  }
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, ".visualice-export"), `${opts.runId}\n`);

  await fs.cp(opts.viewerDist, dest, { recursive: true });
  // `dereference`: the run may be reached through the `latest` symlink.
  await fs.cp(opts.runDir, path.join(dest, "data"), { recursive: true, dereference: true });
  await fs.rm(path.join(dest, "data", ".incomplete"), { force: true });

  const available = await listDiffs(opts.outRoot);
  const wanted = opts.diffs
    ? available.filter((d) => opts.diffs!.includes(d.id))
    : available.filter((d) => d.to === opts.runId);
  const missing = (opts.diffs ?? []).filter((id) => !available.some((d) => d.id === id));
  if (missing.length) throw new Error(`no such comparison: ${missing.join(", ")}`);

  for (const d of wanted) {
    const src = path.join(opts.outRoot, "diffs", d.id);
    await fs.cp(src, path.join(dest, "diffs", d.id), { recursive: true });
    const diff = JSON.parse(await fs.readFile(path.join(src, "diff.json"), "utf8")) as RunDiff;
    // The before/after pictures live in the two runs (or the baseline); copy just
    // the ones this comparison shows, not both runs whole.
    const fromRoot = diff.from.baseline
      ? opts.baselineDir
      : path.join(opts.outRoot, "runs", diff.from.runId);
    const fromDest = diff.from.baseline
      ? path.join(dest, "baseline")
      : path.join(dest, "runs", diff.from.runId);
    const toRoot = path.join(opts.outRoot, "runs", diff.to.runId);
    const toDest = path.join(dest, "runs", diff.to.runId);
    let lost = 0;
    for (const shot of diff.shots) {
      for (const rel of [shot.fromShot, shot.fromPreview]) {
        if (rel && !(await copyFile(path.join(fromRoot, rel), path.join(fromDest, rel)))) lost++;
      }
      for (const rel of [shot.toShot, shot.toPreview]) {
        if (rel && !(await copyFile(path.join(toRoot, rel), path.join(toDest, rel)))) lost++;
      }
    }
    if (lost) log(`⚠ ${d.id}: ${lost} shot(s) it refers to are no longer on disk`);
  }

  await fs.writeFile(
    path.join(dest, "runs.json"),
    JSON.stringify({ current: opts.runId, runs: [opts.runId] }),
  );
  await fs.writeFile(path.join(dest, "diffs.json"), JSON.stringify({ diffs: wanted }));

  return { dest, runId: opts.runId, diffs: wanted.map((d) => d.id), files: await countFiles(dest) };
}
