import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Run directories are named by `makeRunId` (an ISO timestamp with `:`/`.` replaced
 * by `-`). Parsing the id back to a time is what lets pruning and diffing order runs
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
 * directory, a baseline someone copied in) sorts lexically *after* them, so an
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
 * Diff directories under `<outRoot>/diffs`, newest first.
 *
 * `visualice diff` names them `<fromId>__<toId>`, so the *second* id is what
 * orders them: a diff is as recent as the run it was taken against. A directory
 * without a readable `diff.json` isn't a diff and is left out rather than offered
 * as one that fails to open.
 */
export async function listDiffs(
  outRoot: string,
): Promise<{ id: string; from: string; to: string }[]> {
  const dir = path.join(outRoot, "diffs");
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: { id: string; from: string; to: string }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const [from, to] = e.name.split("__");
    if (!from || !to) continue;
    const ok = await fs.access(path.join(dir, e.name, "diff.json")).then(
      () => true,
      () => false,
    );
    if (ok) found.push({ id: e.name, from, to });
  }
  return found.sort((a, b) => {
    const ta = runIdTime(a.to);
    const tb = runIdTime(b.to);
    if (ta !== undefined && tb !== undefined) return tb - ta || b.id.localeCompare(a.id);
    return b.id.localeCompare(a.id);
  });
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

/** Newest run that was never finished, if any. */
export async function findResumableRun(outRoot: string): Promise<string | undefined> {
  const ids = await listRuns(outRoot);
  for (const id of [...ids].reverse()) {
    const marker = path.join(outRoot, "runs", id, INCOMPLETE);
    if (
      await fs.access(marker).then(
        () => true,
        () => false,
      )
    )
      return id;
  }
  return undefined;
}

/** Absolute path of a run directory. */
export function runDir(outRoot: string, id: string): string {
  return path.join(outRoot, "runs", id);
}

/** Resolve `latest` (a symlink) to the run id it points at, if there is one. */
export async function latestRunId(outRoot: string): Promise<string | undefined> {
  const link = path.join(outRoot, "runs", "latest");
  const target = await fs.readlink(link).catch(() => undefined);
  if (target) return path.basename(target);
  // No symlink (Windows without developer mode, or a copied tree): fall back to the
  // newest run directory.
  const runs = await listRuns(outRoot);
  return runs.at(-1);
}
