import path from "node:path";
import { promises as fs } from "node:fs";
import { pathExists } from "../shared/fsx";

/**
 * Run directories are named by `makeRunId` (an ISO timestamp with `:`/`.` replaced
 * by `-`). Parsing the id back to a time is what lets pruning order runs
 * by *when they happened* rather than trusting a lexical sort of whatever names
 * happen to be in the directory.
 */

const RUN_ID_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;

/** Epoch ms for a run id, or undefined when the name isn't one we generated. */
export function runIdTime(id: string): number | undefined {
  const m = RUN_ID_RE.exec(id);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, ms] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Oldest → newest. Ids we can parse sort by time; anything else (a hand-named
 * directory) sorts lexically *after* them, so an
 * unrecognized name is never silently treated as the oldest run and pruned first.
 */
export function sortRunIds(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ta = runIdTime(a);
    const tb = runIdTime(b);
    if (ta !== undefined && tb !== undefined) return ta - tb || a.localeCompare(b);
    if (ta !== undefined) return -1;
    if (tb !== undefined) return 1;
    return a.localeCompare(b);
  });
}

/** Run ids present under `<outRoot>/runs`, oldest → newest. `latest` is a symlink, not a run. */
export async function listRuns(outRoot: string): Promise<string[]> {
  const runsDir = path.join(outRoot, "runs");
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch(() => []);
  const names = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name !== "latest")
    .map((e) => e.name);
  return sortRunIds(names);
}

/**
 * Which of `ids` (oldest → newest) to delete so that `keep` runs remain.
 *
 * `current` — the run just written — survives whatever its age, and it spends one
 * of the `keep` slots doing so. Filtering it out of the doomed set *after* choosing
 * that set (or out of `ids` before, which comes to the same thing) spares it without
 * reclaiming its slot, and the directory quietly holds `keep + 1` runs from then on.
 */
export function runsToPrune(ids: string[], keep: number, current?: string): string[] {
  const others = ids.filter((id) => id !== current);
  const budget = current !== undefined && ids.includes(current) ? keep - 1 : keep;
  return others.slice(0, Math.max(0, others.length - budget));
}

/**
 * A run directory is marked incomplete while it is being written, so an
 * interrupted crawl is distinguishable from a finished one and `--resume` has
 * something unambiguous to pick up.
 */
const INCOMPLETE = ".incomplete";

export async function markRunIncomplete(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, INCOMPLETE), new Date().toISOString());
}

export async function markRunComplete(dir: string): Promise<void> {
  await fs.rm(path.join(dir, INCOMPLETE), { force: true }).catch(() => {});
}

/** Is the run in `dir` finished — not being written, and not waiting on `--resume`? */
export async function isRunComplete(dir: string): Promise<boolean> {
  return !(await pathExists(path.join(dir, INCOMPLETE)));
}

/** Newest run that was never finished, if any. */
export async function findResumableRun(outRoot: string): Promise<string | undefined> {
  const ids = await listRuns(outRoot);
  for (const id of [...ids].reverse()) {
    if (!(await isRunComplete(runDir(outRoot, id)))) return id;
  }
  return undefined;
}

/** Absolute path of a run directory. */
export function runDir(outRoot: string, id: string): string {
  return path.join(outRoot, "runs", id);
}

/** Resolve `latest` (a symlink) to the run id it points at, if there is one. */
export async function latestRunId(outRoot: string): Promise<string | undefined> {
  const link = runDir(outRoot, "latest");
  const target = await fs.readlink(link).catch(() => undefined);
  if (target) return path.basename(target);
  // No symlink (Windows without developer mode, or a copied tree): fall back to the
  // newest run directory.
  const runs = await listRuns(outRoot);
  return runs.at(-1);
}
