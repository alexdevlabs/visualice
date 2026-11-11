import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "../shared/config";
import type { RecipeStep } from "../shared/types";
import { applyRecipe, resolveUrl } from "./recipe";
import { httpContextOptions } from "./context-options";
import { resolveEnvString } from "../shared/env";
import { useTestIdAttribute } from "../shared/selectors";
import { launchOptions } from "../shared/launch";

/**
 * Substitute ${ENV_VAR} placeholders in fill values so secrets stay out of config
 * files. Throws if any referenced var is unset — submitting blank credentials would
 * otherwise save a logged-out session as if authentication succeeded.
 */
export function resolveEnvSteps(steps: RecipeStep[]): RecipeStep[] {
  const missing = new Set<string>();
  const out = steps.map((step) =>
    step.action === "fill" ? { ...step, value: resolveEnvString(step.value, missing) } : step,
  );
  if (missing.size) {
    throw new Error(`auth login: missing env var(s): ${[...missing].join(", ")}`);
  }
  return out;
}

/** The shape Playwright writes; only the cookie names and expiries matter here. */
interface StorageState {
  cookies?: { name: string; expires?: number }[];
}

/** Does a cookie name match one of the configured names? A trailing `*` matches a prefix. */
export function isSessionCookie(name: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * When the saved session's own cookies say it expires, in ms since the epoch.
 *
 * Only the cookies named in `sessionCookies` are consulted, and with none named
 * there is no answer. A login flow's storage state holds every cookie the site set
 * on the way — CSRF tokens, consent banners, analytics — and their expiries say
 * nothing about the session: taking the soonest of them lets a five-minute CSRF
 * cookie force a fresh login on every run, and once any one of them lapses the
 * session never looks fresh again. Which cookie *is* the session is something only
 * the site's owner knows.
 *
 * Browser-session cookies (`expires` of -1) have no expiry to read and are ignored;
 * among the named cookies the soonest real expiry wins, since that is what logs
 * the crawl out.
 */
export async function storageStateExpiry(
  file: string,
  sessionCookies: string[] = [],
): Promise<number | undefined> {
  if (!sessionCookies.length) return undefined;
  const raw = await fs.readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  let state: StorageState;
  try {
    state = JSON.parse(raw) as StorageState;
  } catch {
    return undefined; // unreadable: fall back to mtime
  }
  const expiries = (state.cookies ?? [])
    .filter((c) => isSessionCookie(c.name, sessionCookies))
    .map((c) => c.expires)
    .filter((e): e is number => typeof e === "number" && e > 0)
    .map((e) => e * 1000); // Playwright stores seconds
  return expiries.length ? Math.min(...expiries) : undefined;
}

/** An error message with every value a recipe types or selects taken out. */
export function scrubSecrets(message: string, steps: RecipeStep[]): string {
  const values = steps
    .flatMap((s) => (s.action === "fill" || s.action === "select" ? [s.value] : []))
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    // Longest first, so a value that contains another goes whole.
    .sort((a, b) => b.length - a.length);
  let out = message;
  for (const v of values) {
    for (const form of new Set([v, JSON.stringify(v).slice(1, -1)])) {
      out = out.split(form).join("•••");
    }
  }
  return out;
}

const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Does a saved session have anything for `target`'s host: a cookie whose domain
 * covers it, or stored data for its origin? An empty state covers anything (there is
 * nothing in it to belong elsewhere), as does one that can't be read.
 */
export async function storageStateCovers(file: string, target: string): Promise<boolean> {
  let state: StorageState & { origins?: { origin: string }[] };
  let url: URL;
  try {
    state = JSON.parse(await fs.readFile(file, "utf8")) as typeof state;
    url = new URL(target);
  } catch {
    return true;
  }
  const cookies = state.cookies ?? [];
  const origins = state.origins ?? [];
  if (!cookies.length && !origins.length) return true;
  const host = url.hostname.toLowerCase();
  return (
    origins.some((o) => o.origin === url.origin) ||
    cookies.some((c) => {
      const domain = String((c as { domain?: string }).domain ?? "")
        .toLowerCase()
        .replace(/^\./, "");
      // A cookie that doesn't say where it is from can't be said to be from elsewhere.
      return domain === "" || host === domain || host.endsWith(`.${domain}`);
    })
  );
}

/**
 * Ensure a Playwright storageState file exists for authenticated crawls.
 * - Reuses a stored session while it is still valid — by the expiry of the cookies
 *   named in `login.sessionCookies`, else by age (`login.maxAgeHours`).
 * - Otherwise, if a login recipe is configured, runs it once and saves the session.
 * - Returns the absolute path to use as `storageState`, or undefined for anonymous crawls.
 */
export async function ensureStorageState(
  config: Config,
  log: (m: string) => void,
  /** The site being crawled (`--target`), when it isn't the config's `target`. */
  baseUrl?: string,
): Promise<string | undefined> {
  const target = baseUrl ?? config.target;
  const sp = config.auth.storageStatePath;
  if (!sp) return undefined;

  const abs = path.resolve(sp);
  const login = config.auth.login;
  const maxAgeHours = login?.maxAgeHours ?? 12;

  const stat = await fs.stat(abs).catch(() => null);
  if (stat) {
    if (!login) return abs; // no recipe to refresh with — use what we have
    // The named session cookie's expiry is the session's own answer; `maxAgeHours` is
    // the fallback when none is named or it carries no expiry. A minute of slack keeps
    // a crawl from starting with a session that expires while it runs.
    const expiry = await storageStateExpiry(abs, login.sessionCookies);
    const fresh =
      expiry !== undefined
        ? expiry - Date.now() > 60_000
        : (Date.now() - stat.mtimeMs) / 3.6e6 < maxAgeHours;
    // A session saved for another host (staging, when this crawl is of production)
    // is no session here, however new it is.
    const elsewhere = target ? !(await storageStateCovers(abs, target)) : false;
    if (fresh && !elsewhere) return abs;
    log(
      elsewhere
        ? `saved session is for another site than ${safeHost(target!)}`
        : expiry !== undefined
          ? `saved session expired (session cookie expired ${new Date(expiry).toISOString()})`
          : `saved session is older than ${maxAgeHours}h`,
    );
  } else if (!login) {
    return undefined; // nothing saved and no way to create it
  }

  log("authenticating (running login recipe)…");
  useTestIdAttribute(config.testIdAttribute);
  const browser = await chromium.launch(launchOptions());
  try {
    const context = await browser.newContext(httpContextOptions(config));
    const page = await context.newPage();
    // Against the site being crawled: `crawl https://staging…` must not type the
    // credentials into the config's production `target`.
    const startUrl = login?.url ? resolveUrl(target ?? "http://localhost", login.url) : target;
    if (startUrl) await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    const steps = resolveEnvSteps((login?.steps ?? []) as RecipeStep[]);
    try {
      await applyRecipe(page, steps);
    } catch (e) {
      // Playwright's error repeats the call, typed value and all (`fill("hunter2")`).
      throw new Error(`auth login: ${scrubSecrets((e as Error).message, steps)}`);
    }

    // Verify success BEFORE saving — otherwise a changed login form quietly persists
    // a logged-out session and the whole run screenshots the login wall.
    const verify = login?.verify;
    if (verify?.url || verify?.selector) {
      try {
        if (verify.url) await page.waitForURL(verify.url, { timeout: verify.timeoutMs });
        if (verify.selector) {
          await page
            .locator(verify.selector)
            .first()
            .waitFor({ state: "visible", timeout: verify.timeoutMs });
        }
      } catch {
        throw new Error(
          `auth login: post-login verification failed (still at ${page.url()}) — ` +
            `expected ${verify.url ? `url "${verify.url}"` : `visible "${verify.selector}"`}. ` +
            `Session NOT saved; check credentials or update auth.login.steps.`,
        );
      }
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    await context.storageState({ path: abs });
    log(`saved auth storage state → ${abs}`);
    return abs;
  } finally {
    await browser.close();
  }
}
