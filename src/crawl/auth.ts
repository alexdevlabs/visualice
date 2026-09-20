import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Config } from "../shared/config";
import type { RecipeStep } from "../shared/types";
import { applyRecipe, resolveUrl } from "./recipe";
import { httpContextOptions } from "./context-options";
import { resolveEnvString } from "../shared/env";

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

/** The shape Playwright writes; only the cookie expiries matter here. */
interface StorageState {
  cookies?: { name: string; expires?: number }[];
}

/**
 * When the saved session's own cookies say it expires, in ms since the epoch.
 *
 * File mtime only says when the session was *written*, which is a guess at when it
 * stops working. The cookies carry the real answer, so a short-lived session is
 * refreshed when it actually expires rather than when a fixed age elapses. Session
 * cookies (`expires` of -1) have no expiry to read and are ignored; the soonest
 * real expiry wins, since that's what logs the crawl out.
 */
export async function storageStateExpiry(file: string): Promise<number | undefined> {
  const raw = await fs.readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  let state: StorageState;
  try {
    state = JSON.parse(raw) as StorageState;
  } catch {
    return undefined; // unreadable: fall back to mtime
  }
  const expiries = (state.cookies ?? [])
    .map((c) => c.expires)
    .filter((e): e is number => typeof e === "number" && e > 0)
    .map((e) => e * 1000); // Playwright stores seconds
  return expiries.length ? Math.min(...expiries) : undefined;
}

/**
 * Ensure a Playwright storageState file exists for authenticated crawls.
 * - Reuses a stored session while it is still valid (by cookie expiry, else by age).
 * - Otherwise, if a login recipe is configured, runs it once and saves the session.
 * - Returns the absolute path to use as `storageState`, or undefined for anonymous crawls.
 */
export async function ensureStorageState(
  config: Config,
  log: (m: string) => void,
): Promise<string | undefined> {
  const sp = config.auth.storageStatePath;
  if (!sp) return undefined;

  const abs = path.resolve(sp);
  const login = config.auth.login;
  const maxAgeHours = login?.maxAgeHours ?? 12;

  const stat = await fs.stat(abs).catch(() => null);
  if (stat) {
    if (!login) return abs; // no recipe to refresh with — use what we have
    // Cookie expiry is the session's own answer; `maxAgeHours` is the fallback for
    // sessions whose cookies don't carry one. A minute of slack keeps a crawl from
    // starting with a session that expires while it runs.
    const expiry = await storageStateExpiry(abs);
    const fresh =
      expiry !== undefined
        ? expiry - Date.now() > 60_000
        : (Date.now() - stat.mtimeMs) / 3.6e6 < maxAgeHours;
    if (fresh) return abs;
    log(
      expiry !== undefined
        ? `saved session expired (cookies expired ${new Date(expiry).toISOString()})`
        : `saved session is older than ${maxAgeHours}h`,
    );
  } else if (!login) {
    return undefined; // nothing saved and no way to create it
  }

  log("authenticating (running login recipe)…");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext(httpContextOptions(config));
    const page = await context.newPage();
    const startUrl = login?.url
      ? resolveUrl(config.target ?? "http://localhost", login.url)
      : config.target;
    if (startUrl) await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await applyRecipe(page, resolveEnvSteps((login?.steps ?? []) as RecipeStep[]));

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
