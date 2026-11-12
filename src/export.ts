import path from "node:path";
import { promises as fs } from "node:fs";
import { pathExists } from "./shared/fsx";
import type { SiteList } from "./serve";

/**
 * A self-contained copy of the viewer and one run, for somewhere `visualice serve`
 * isn't: a CI artifact, a static host, a folder handed to a reviewer.
 *
 * The layout is the one `serve` presents over HTTP, written to disk — the viewer
 * only ever asks for relative URLs, so any static file server can stand in:
 *
 *   index.html, assets/   the built viewer
 *   data/                 the run
 *   sites.json            the (one-entry) site and run list
 *   update.json           `{}`: a shared copy has no update banner to show
 */

export interface ExportOptions {
  runDir: string;
  runId: string;
  /** The site the run belongs to, named in the exported site list. */
  site?: string;
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

  // Not the viewer's own data/: a dev build can carry another run there, and the
  // export's data/ is this run alone.
  await fs.cp(opts.viewerDist, dest, {
    recursive: true,
    filter: (src) => path.relative(opts.viewerDist, src).split(path.sep)[0] !== "data",
  });
  // `dereference`: the run may be reached through the `latest` symlink.
  await fs.cp(opts.runDir, path.join(dest, "data"), { recursive: true, dereference: true });
  await fs.rm(path.join(dest, "data", ".incomplete"), { force: true });

  const site = opts.site ?? "site";
  const list: SiteList = {
    current: { site, run: opts.runId },
    sites: [{ key: site, latest: opts.runId, runs: [opts.runId] }],
  };
  await fs.writeFile(path.join(dest, "sites.json"), JSON.stringify(list));
  // The viewer asks `serve` whether a newer visualice is out. Whoever opens an export
  // isn't running this install, so the answer is always "nothing to say".
  await fs.writeFile(path.join(dest, "update.json"), "{}");

  return { dest, runId: opts.runId, files: await countFiles(dest) };
}
