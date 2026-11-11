import type { Page, Response } from "playwright";
import type { RecipeStep } from "../shared/types";
import { locatorFor } from "../shared/selectors";
import { namesGeneratedId } from "./generated-ids";

export function resolveUrl(base: string, u: string): string {
  return /^https?:\/\//i.test(u) ? u : new URL(u, base).href;
}

/**
 * Navigate to a route URL and come back with a freshly rendered document.
 *
 * Changing only the fragment is a *same-document* navigation: the browser fires
 * `hashchange` instead of loading anything, `goto` resolves with no response, and
 * whatever the previous route left on screen is still there while the router
 * catches up. On a hash-routed SPA — where consecutive routes differ by nothing
 * else — that is the difference between screenshotting the right page and
 * screenshotting the one before it. Reloading makes arriving at the route
 * identical to arriving at it cold, which is the only thing a recipe recorded
 * against it can rely on.
 *
 * `networkidle` is waited for past `load`, not instead of it, and only for so
 * long: a page that polls (a live-activity feed, analytics heartbeats) never goes
 * quiet, and treating that as a failed navigation failed every visit to it.
 */
export async function gotoRoute(
  page: Page,
  url: string,
  waitUntil?: "load" | "domcontentloaded" | "networkidle",
  timeout?: number,
): Promise<Response | null> {
  const idle = waitUntil === "networkidle";
  const loadUntil = idle ? "load" : waitUntil;
  let response = await page.goto(url, { waitUntil: loadUntil, timeout });
  // A null response is Playwright's way of saying "same document" — the only
  // navigation that produces no request at all.
  if (response === null && new URL(url, page.url()).hash) {
    response = await page.reload({ waitUntil: loadUntil, timeout });
  }
  if (idle) {
    await page
      .waitForLoadState("networkidle", {
        timeout: Math.min(timeout ?? NETWORK_IDLE_MS, NETWORK_IDLE_MS),
      })
      .catch(() => {});
  }
  return response;
}

/** The longest a loaded page is given to go network-idle before it is used anyway. */
export const NETWORK_IDLE_MS = 10_000;

/** How long a wait for a generated id (from an older recipe) holds before moving on. */
const GENERATED_ID_WAIT_MS = 1500;

/** Replay an ordered list of interaction steps on a page. */
export async function applyRecipe(page: Page, steps: RecipeStep[]): Promise<void> {
  for (const step of steps) {
    switch (step.action) {
      case "navigate":
        await page.goto(new URL(step.url, page.url()).href);
        break;
      case "click":
        await locatorFor(page, step.target).click();
        break;
      case "hover":
        await locatorFor(page, step.target).hover();
        break;
      case "focus":
        await locatorFor(page, step.target).focus();
        break;
      case "blur":
        // Blur whatever is focused without moving focus somewhere that could open
        // its own state — a Tab press would land on the next control and focus that.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        break;
      case "fill":
        await locatorFor(page, step.target).fill(step.value);
        break;
      case "select":
        await locatorFor(page, step.target).selectOption(step.value);
        break;
      case "press":
        if (step.target) await locatorFor(page, step.target).press(step.key);
        else await page.keyboard.press(step.key);
        break;
      case "waitFor":
        if (step.selector && namesGeneratedId(step.selector)) {
          // Recorded before generated ids were recognised: the id it names most
          // likely differs on this load. The step before it already did the work,
          // so give the element a moment and carry on instead of failing.
          await page
            .locator(step.selector)
            .first()
            .waitFor({ state: step.state ?? "visible", timeout: GENERATED_ID_WAIT_MS })
            .catch(() => {});
        } else if (step.selector)
          await page
            .locator(step.selector)
            .first()
            .waitFor({ state: step.state ?? "visible", timeout: step.timeoutMs });
        else if (step.url) await page.waitForURL(step.url, { timeout: step.timeoutMs });
        else if (step.timeoutMs) await page.waitForTimeout(step.timeoutMs);
        break;
      case "scroll":
        if (step.to === "top") await page.evaluate(() => window.scrollTo(0, 0));
        else if (step.to === "bottom")
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        else await page.evaluate((y) => window.scrollTo(0, y), step.to);
        break;
      case "wait":
        await page.waitForTimeout(step.ms);
        break;
    }
  }
}
