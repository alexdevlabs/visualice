import type { Page, Response } from "playwright";
import type { RecipeStep } from "../shared/types";
import { locatorFor } from "../shared/selectors";
import { idOfSelector, isGeneratedId, namesGeneratedId } from "./generated-ids";

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

/**
 * What is open on the page, counted: dialogs and popups, expanded triggers, open
 * `<details>`, and elements a component library marks open. Compared before and
 * after a click to tell whether the click opened something, in terms every
 * framework shares.
 */
const countOpen = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const count = (sel: string, visibleOnly: boolean) =>
      Array.from(document.querySelectorAll(sel)).filter((el) => !visibleOnly || shown(el)).length;
    return [
      count(
        'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"]',
        true,
      ),
      count('[aria-expanded="true"]', false),
      count("details[open]", false),
      count('[data-state="open"],[data-open]', true),
    ];
  });

/**
 * Wait for the element a recipe names by id, or for the click before it to have
 * opened something: whichever comes first. The id was right when the state was
 * recorded, but a site can generate it (a counter, React's useId) and give the same
 * dialog another one on this load; what the click does doesn't change. An id
 * already known to be generated isn't waited for at all.
 */
async function waitForIdOrOpened(
  page: Page,
  selector: string,
  generated: boolean,
  before: number[],
  timeout: number | undefined,
): Promise<void> {
  const byId = generated
    ? undefined
    : page.locator(selector).first().waitFor({ state: "visible", timeout });
  const opened = page.waitForFunction(
    (was) => {
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      };
      const count = (sel: string, visibleOnly: boolean) =>
        Array.from(document.querySelectorAll(sel)).filter((el) => !visibleOnly || shown(el)).length;
      const now = [
        count(
          'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"]',
          true,
        ),
        count('[aria-expanded="true"]', false),
        count("details[open]", false),
        count('[data-state="open"],[data-open]', true),
      ];
      return now.some((n, i) => n > was[i]);
    },
    before,
    { timeout, polling: 100 },
  );
  const waits = byId ? [byId, opened] : [opened];
  for (const w of waits) w.catch(() => {}); // the loser times out on its own
  try {
    await Promise.any(waits);
  } catch {
    // Neither: report the id the recipe asked for, as before.
    await (byId ?? opened);
  }
}

/** Replay an ordered list of interaction steps on a page. */
export async function applyRecipe(page: Page, steps: RecipeStep[]): Promise<void> {
  /** What was open just before the step a following id-wait depends on. */
  let before: number[] | undefined;
  for (const [i, step] of steps.entries()) {
    const next = steps[i + 1];
    if (
      (step.action === "click" || step.action === "hover" || step.action === "press") &&
      next?.action === "waitFor" &&
      next.selector &&
      (next.state ?? "visible") === "visible" &&
      idOfSelector(next.selector) !== undefined
    ) {
      before = await countOpen(page).catch(() => undefined);
    }
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
        if (step.selector && before && idOfSelector(step.selector) !== undefined) {
          const id = idOfSelector(step.selector)!;
          await waitForIdOrOpened(page, step.selector, isGeneratedId(id), before, step.timeoutMs);
        } else if (step.selector && namesGeneratedId(step.selector)) {
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
        before = undefined;
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
