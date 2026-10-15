import path from "node:path";
import { promises as fs } from "node:fs";
import { startServer, serveFileFromRoot, type StaticServer } from "./shared/file-serve";
import { isRunComplete, latestRunId, listRuns, listSites, runDir, siteDir } from "./crawl/runs";

/** A run at a glance, for the dashboard's card. */
export interface RunSummary {
  title?: string;
  origin?: string;
  routes: number;
  states: number;
  shots: number;
  failed: number;
  /** The home page's default desktop shot, relative to the run directory. */
  thumb?: string;
}

/** What `/sites.json` answers: every site with runs, and which run is on screen. */
export interface SiteList {
  current: { site?: string; run: string };
  /** By name; each site's runs newest first, and a summary of its latest. */
  sites: { key: string; latest?: string; runs: string[]; summary?: RunSummary }[];
}

interface MapForSummary {
  site?: { title?: string; origin?: string };
  devices?: { name: string; mobile?: boolean }[];
  routes?: { url: string; states: { kind?: string; shots?: Record<string, ShotPaths> }[] }[];
  stats?: { routes: number; states: number; shots: number; failed: number };
}
interface ShotPaths {
  mid?: string;
  thumb?: string;
  error?: string;
}

/**
 * Summarize the run in `dir` from its crawl map. A finished run never changes, so
 * the answer is kept per directory and modification time: the dashboard asks on
 * every load, and a re-crawl writes a new map, which is a new time.
 */
const summaries = new Map<string, { mtimeMs: number; summary?: RunSummary }>();
async function runSummary(dir: string): Promise<RunSummary | undefined> {
  const file = path.join(dir, "crawl-map.json");
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat) return undefined;
  const hit = summaries.get(dir);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.summary;
  let summary: RunSummary | undefined;
  try {
    const map = JSON.parse(await fs.readFile(file, "utf8")) as MapForSummary;
    const routes = map.routes ?? [];
    // The site's front door: the root page, else whichever page came first.
    const home = routes.find((r) => r.url === "/") ?? routes[0];
    const shots = home?.states.find((s) => s.kind === "default")?.shots ?? {};
    const desktop = map.devices?.find((d) => !d.mobile)?.name;
    const shot = (desktop ? shots[desktop] : undefined) ?? Object.values(shots)[0];
    summary = {
      title: map.site?.title,
      origin: map.site?.origin,
      routes: map.stats?.routes ?? routes.length,
      states: map.stats?.states ?? routes.reduce((n, r) => n + r.states.length, 0),
      shots: map.stats?.shots ?? 0,
      failed: map.stats?.failed ?? 0,
      thumb: shot && !shot.error ? (shot.mid ?? shot.thumb) : undefined,
    };
  } catch {
    // A map that doesn't parse has nothing to summarize; the card shows what it can.
  }
  summaries.set(dir, { mtimeMs: stat.mtimeMs, summary });
  return summary;
}

/**
 * Whether `name`, taken from a URL, names an entry directly inside `dir`. Rejects
 * `.`, `..` and anything holding a separator — on Windows a `\` too, which the
 * URL's own `/` split doesn't catch — so a root built from it can't leave `dir`.
 */
export function isChild(dir: string, name: string): boolean {
  return (
    path.dirname(path.resolve(dir, name)) === path.resolve(dir) &&
    path.basename(name) === name &&
    name !== "." &&
    name !== ".."
  );
}

/** Every site under `outRoot` and its runs, for the dashboard and the viewer's pickers. */
export async function siteList(outRoot: string, current: SiteList["current"]): Promise<SiteList> {
  const sites = await Promise.all(
    (await listSites(outRoot)).map(async (key) => {
      const root = siteDir(outRoot, key);
      const latest = await latestRunId(root);
      const summary = latest ? await runSummary(runDir(root, latest)) : undefined;
      return { key, latest, runs: (await listRuns(root)).reverse(), summary };
    }),
  );
  return { current, sites };
}

/**
 * Serve the built viewer at `/` and run data underneath it.
 *
 * - `/data/…`                    the run that was asked for (what the viewer loads by default)
 * - `/sites/<site>/runs/<id>/…`  any run of any site in the same output directory
 * - `/runs/<id>/…`               a run of the current site (older links name no site)
 * - `/sites.json`                the sites and their runs, so the viewer can offer pickers
 *
 * Exposing the other runs is what lets the viewer change site or version without
 * restarting the server. `outRoot` stays optional so a bare run directory still serves.
 */
export async function serveViewer(opts: {
  runDir: string;
  viewerDist: string;
  /** The output root (the directory holding `sites/`). Enables the pickers. */
  outRoot?: string;
  /** Site the current run belongs to. */
  site?: string;
  /** Run id shown as current in `/sites.json`. */
  runId?: string;
  port?: number;
}): Promise<StaticServer> {
  const runDir = path.resolve(opts.runDir);
  const viewerDist = path.resolve(opts.viewerDist);
  const outRoot = opts.outRoot ? path.resolve(opts.outRoot) : undefined;
  const sitesDir = outRoot ? path.join(outRoot, "sites") : undefined;
  const current = { site: opts.site, run: opts.runId ?? path.basename(runDir) };

  /**
   * Serve `rel` from under `root`, where the first segment of `rel` is a run id. A
   * finished run's id names its output forever, so its images may be cached for
   * good. Not `latest`, the same alias `/data/` is; and not a run still being
   * written, where `--resume` recaptures a half-written image at the same path.
   * `serveFileFromRoot` confines the path to the root, so a `..` can't escape it.
   */
  const serveRun = async (
    res: Parameters<typeof serveFileFromRoot>[0],
    req: Parameters<typeof serveFileFromRoot>[3],
    root: string,
    rel: string,
  ): Promise<boolean> => {
    const id = rel.split("/")[0];
    const immutable =
      !!id && id !== "latest" && isChild(root, id) && (await isRunComplete(path.join(root, id)));
    return !!rel && serveFileFromRoot(res, root, rel, req, { immutable });
  };

  return startServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/sites.json") {
        const list = outRoot ? await siteList(outRoot, current) : { current, sites: [] };
        res.setHeader("content-type", "application/json; charset=utf-8");
        // Never cached: the point of the list is to reflect runs added since load.
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify(list));
        return;
      }

      if (pathname.startsWith("/data/")) {
        // Never immutable: `/data/` is whichever run this server was pointed at, which
        // by default is `latest`, and a re-crawl changes it without changing a URL.
        const rel = pathname.slice("/data/".length) || "viewer-data.json";
        if (await serveFileFromRoot(res, runDir, rel, req)) return;
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      if (sitesDir && pathname.startsWith("/sites/")) {
        // `/sites/<site>/runs/<id>/…`: confined to that site's runs directory.
        const [site, runs, ...rest] = pathname.slice("/sites/".length).split("/");
        const ok =
          site &&
          isChild(sitesDir, site) &&
          runs === "runs" &&
          (await serveRun(res, req, path.join(sitesDir, site, "runs"), rest.join("/")));
        if (ok) return;
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      if (outRoot && current.site && pathname.startsWith("/runs/")) {
        const root = path.join(siteDir(outRoot, current.site), "runs");
        if (await serveRun(res, req, root, pathname.slice("/runs/".length))) return;
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      const rel = pathname === "/" ? "index.html" : pathname;
      if (await serveFileFromRoot(res, viewerDist, rel, req)) return;
      if (await serveFileFromRoot(res, viewerDist, "index.html", req)) return; // SPA fallback
      res.statusCode = 404;
      res.end("not found");
    } catch {
      res.statusCode = 500;
      res.end("error");
    }
  }, opts.port);
}
