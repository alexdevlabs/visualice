/**
 * `sites.json`: every site the server can show and its runs, plus which run it was
 * started on. Optional — a viewer served from a bare directory or an old export
 * has none, and then it is a viewer of that one run.
 */

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

export interface SiteEntry {
  key: string;
  latest?: string;
  /** Newest first. */
  runs: string[];
  /** The latest run at a glance. */
  summary?: RunSummary;
}

export interface SiteList {
  current: { site?: string; run: string };
  sites: SiteEntry[];
}

export async function fetchSites(): Promise<SiteList | null> {
  try {
    const r = await fetch("./sites.json");
    const list = r.ok ? ((await r.json()) as SiteList) : null;
    return list?.sites?.length ? list : null;
  } catch {
    return null;
  }
}

/** The run a site opens on: its `latest`, else its newest. */
export const openingRun = (s: SiteEntry): string | undefined => s.latest ?? s.runs[0];

/** Where a run's files are served. */
export const runBase = (site: string, run: string): string =>
  `./sites/${encodeURIComponent(site)}/runs/${encodeURIComponent(run)}/`;

/** The viewer's address for one run of one site. */
export const runHref = (site: string, run: string): string =>
  `?${new URLSearchParams({ site, run }).toString()}`;
