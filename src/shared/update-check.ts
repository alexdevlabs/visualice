import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

// "A newer visualice is out" notice. A plugin install doesn't auto-update by default,
// and the plugin's skill pins the CLI version it runs, so without this a user only
// learns about a release by going to look. The check is cheap and never in the way:
// the notice comes from a cached answer, the registry is asked at most once a day,
// and a slow or failed lookup is dropped without a word.

const REGISTRY_URL = "https://registry.npmjs.org/visualice/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;

interface Cache {
  checkedAt: number;
  latest?: string;
}

/** Where the last answer is kept: the user's cache folder, outside any project. */
export function cacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.XDG_CACHE_HOME ||
    (process.platform === "win32" && env.LOCALAPPDATA) ||
    path.join(os.homedir(), ".cache");
  return path.join(base, "visualice", "update-check.json");
}

/** Is the check switched off here: opted out, CI, or a test run? */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(
    env.VISUALICE_NO_UPDATE_CHECK ||
    env.NO_UPDATE_NOTIFIER ||
    env.CI ||
    env.VITEST ||
    env.NODE_ENV === "test"
  );
}

/** `a` > `b` for plain x.y.z versions; a prerelease is never "newer". */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? m.slice(1).map(Number) : undefined;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** The notice for a user on `current` when `latest` is out. */
export function updateNotice(current: string, latest: string): string {
  return (
    `visualice ${latest} is available (you have ${current}). Update the plugin: ` +
    `claude plugin update visualice@visualice — or the CLI: npm i -g visualice@latest`
  );
}

async function readCache(file: string): Promise<Cache | undefined> {
  try {
    const c = JSON.parse(await fs.readFile(file, "utf8")) as Cache;
    return typeof c.checkedAt === "number" ? c : undefined;
  } catch {
    return undefined;
  }
}

export interface UpdateCheck {
  /** The notice to show now, from the cached answer; undefined when up to date. */
  notice?: string;
  /** Settles once a stale cache has been refreshed (never rejects). */
  refreshed: Promise<void>;
}

/**
 * Start an update check for `current`. The notice comes from the last answer at
 * once; when that answer is a day old, the registry is asked again in the background
 * and the next run shows what it said.
 */
export async function startUpdateCheck(
  current: string,
  opts: { file?: string; now?: number; fetchFn?: typeof fetch } = {},
): Promise<UpdateCheck> {
  const file = opts.file ?? cacheFile();
  const now = opts.now ?? Date.now();
  const cache = await readCache(file);
  const notice =
    cache?.latest && isNewer(cache.latest, current)
      ? updateNotice(current, cache.latest)
      : undefined;
  if (cache && now - cache.checkedAt < DAY_MS) return { notice, refreshed: Promise.resolve() };
  return { notice, refreshed: refresh(file, now, opts.fetchFn ?? fetch, cache) };
}

async function refresh(
  file: string,
  now: number,
  fetchFn: typeof fetch,
  previous: Cache | undefined,
): Promise<void> {
  let latest = previous?.latest;
  try {
    const res = await fetchFn(REGISTRY_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === "string") latest = body.version;
    }
  } catch {
    // offline, blocked or slow: try again tomorrow
  }
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ checkedAt: now, latest } satisfies Cache));
  } catch {
    // a read-only home: the check just runs again next time
  }
}
