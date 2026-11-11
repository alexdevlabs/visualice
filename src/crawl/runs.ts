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

/** Run ids present under `<root>/runs`, oldest → newest. `latest` is a symlink, not a run. */
export async function listRuns(root: string): Promise<string[]> {
  const runsDir = path.join(root, "runs");
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

/**
 * The run to resume: the newest one, when it was never finished. An unfinished run
 * with finished ones after it is history (an old crawl that was interrupted and then
 * superseded): resuming it would pass its old shots off as today's.
 */
export async function findResumableRun(root: string): Promise<string | undefined> {
  const newest = (await listRuns(root)).at(-1);
  return newest && !(await isRunComplete(runDir(root, newest))) ? newest : undefined;
}

/** Absolute path of a run directory under `root` (a site's directory). */
export function runDir(root: string, id: string): string {
  return path.join(root, "runs", id);
}

/** Resolve `latest` (a symlink) to the run id it points at, if there is one. */
export async function latestRunId(root: string): Promise<string | undefined> {
  const link = runDir(root, "latest");
  const target = await fs.readlink(link).catch(() => undefined);
  if (target) return path.basename(target);
  // No symlink (Windows without developer mode, or a copied tree): fall back to the
  // newest run directory.
  const runs = await listRuns(root);
  return runs.at(-1);
}

/** Point `<root>/runs/latest` at `id`. Best effort: without symlinks, readers fall back. */
export async function updateLatest(root: string, id: string): Promise<void> {
  const link = runDir(root, "latest");
  await fs.rm(link, { force: true }).catch(() => {});
  await fs.symlink(id, link, "dir").catch(() => {});
}

/*
 * Sites. Runs are kept per site — `<outRoot>/sites/<site>/runs/<runId>/` — so each
 * site has its own history, its own `latest` and its own `keepRuns` budget, and a
 * crawl of one site never prunes another's runs.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * The directory name a site's runs live under: its hostname, without `www.`. A
 * loopback host drops its port, since dev servers and the fixture pick a new one
 * every time and would otherwise scatter one site across many; any other host keeps
 * a non-default port, which there usually means a different app. `override` (the
 * config's `output.site`) wins when given.
 */
export function siteKey(baseUrl: string, override?: string): string {
  if (override) return sanitizeSiteKey(override);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return sanitizeSiteKey(baseUrl);
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port && !LOOPBACK.has(url.hostname) ? `-${url.port}` : "";
  return sanitizeSiteKey(host + port);
}

/** Safe as one path segment everywhere: no separators, no `..`, nothing a URL must escape. */
function sanitizeSiteKey(raw: string): string {
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return key || "site";
}

/** A site's directory: what `listRuns`, `runDir` and `latestRunId` take as `root`. */
export function siteDir(outRoot: string, site: string): string {
  return path.join(outRoot, "sites", site);
}

/** Sites with at least one run, by name. */
export async function listSites(outRoot: string): Promise<string[]> {
  const sitesDir = path.join(outRoot, "sites");
  const entries = await fs.readdir(sitesDir, { withFileTypes: true }).catch(() => []);
  const sites: string[] = [];
  for (const e of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if ((await listRuns(siteDir(outRoot, e.name))).length) sites.push(e.name);
  }
  return sites;
}

/** The site whose newest run is the most recent of all — what to show when nothing is asked for. */
export async function newestSite(outRoot: string): Promise<string | undefined> {
  let best: { site: string; time: number } | undefined;
  for (const site of await listSites(outRoot)) {
    const id = (await listRuns(siteDir(outRoot, site))).at(-1);
    const time = id ? (runIdTime(id) ?? 0) : 0;
    if (!best || time > best.time) best = { site, time };
  }
  return best?.site;
}

/** The base URL a run was taken of, read from its manifest. */
async function runBaseUrl(dir: string): Promise<string | undefined> {
  for (const file of ["crawl-map.json", "viewer-data.json"]) {
    const raw = await fs.readFile(path.join(dir, file), "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    try {
      const base = (JSON.parse(raw) as { site?: { baseUrl?: unknown } }).site?.baseUrl;
      if (typeof base === "string") return base;
    } catch {
      // A truncated manifest says nothing about its site; try the next file.
    }
  }
  return undefined;
}

/**
 * Move runs from the old flat layout (`<outRoot>/runs/<id>/`) into their sites,
 * each going where its own manifest's base URL says. A run whose site can't be read
 * — one interrupted before its manifest was written — stays where it is, as does
 * anything we didn't name. Call it under the output directory's lock.
 */
export async function migrateFlatRuns(
  outRoot: string,
  log: (msg: string) => void = () => {},
): Promise<number> {
  const flatDir = path.join(outRoot, "runs");
  if (!(await pathExists(flatDir))) return 0;
  const touched = new Set<string>();
  let moved = 0;
  for (const id of await listRuns(outRoot)) {
    if (runIdTime(id) === undefined) continue;
    const from = runDir(outRoot, id);
    const base = await runBaseUrl(from);
    if (!base) {
      log(`⚠ left run ${id} in ${flatDir}: no manifest to say which site it is`);
      continue;
    }
    const site = siteKey(base);
    const to = runDir(siteDir(outRoot, site), id);
    if (await pathExists(to)) continue;
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.rename(from, to);
    touched.add(site);
    moved++;
  }
  for (const site of touched) {
    const root = siteDir(outRoot, site);
    const newest = (await listRuns(root)).at(-1);
    if (newest) await updateLatest(root, newest);
  }
  // The old `latest` pointed into the flat directory; with every run gone from it,
  // the directory itself goes too.
  if ((await listRuns(outRoot)).length === 0) {
    await fs.rm(runDir(outRoot, "latest"), { force: true }).catch(() => {});
    await fs.rmdir(flatDir).catch(() => {});
  }
  if (moved)
    log(`moved ${moved} run(s) into per-site folders under ${path.join(outRoot, "sites")}`);
  return moved;
}
