import path from "node:path";
import { promises as fs } from "node:fs";
import { pathExists } from "./shared/fsx";

/**
 * A self-contained copy of the viewer and one run, for somewhere `visualice serve`
 * isn't: a CI artifact, a static host, a folder handed to a reviewer.
 *
 * The layout is the one `serve` presents over HTTP, written to disk — the viewer
 * only ever asks for relative URLs, so any static file server can stand in:
 *
 *   index.html, assets/   the built viewer
 *   data/                 the run
 *   runs.json             the (one-entry) run list
 */

export interface ExportOptions {
  runDir: string;
  runId: string;
  viewerDist: string;
  dest: string;
}

export interface ExportResult {
  dest: string;
  runId: string;
  files: number;
}

async function countFiles(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((e) => e.isFile()).length;
}

export async function exportRun(opts: ExportOptions): Promise<ExportResult> {
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

  await fs.writeFile(
    path.join(dest, "runs.json"),
    JSON.stringify({ current: opts.runId, runs: [opts.runId] }),
  );

  return { dest, runId: opts.runId, files: await countFiles(dest) };
}
