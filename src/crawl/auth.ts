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

/**
 * Ensure a Playwright storageState file exists for authenticated crawls.
 * - Reuses a recent storageState if present.
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
    const ageHours = (Date.now() - stat.mtimeMs) / 3.6e6;
    if (ageHours < maxAgeHours || !login) return abs; // fresh, or no recipe to refresh with
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
