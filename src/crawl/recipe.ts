import type { Page, Response } from "playwright";
import type { RecipeStep } from "../shared/types";
import { locatorFor, visibleMatch } from "../shared/selectors";
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
 * How long the element a recipe names by id gets to appear before the step settles
 * for "the click opened something" instead.
 */
const ID_GRACE_MS = 3000;

/**
 * What is open on the page: dialogs and popups, open `<details>`, and regions a
 * component library marks open. Compared before and after a click to tell whether
 * it opened something, in terms every framework shares. Triggers are left out —
 * a button's own `aria-expanded` or `data-state` flips the instant it's clicked,
 * before what it opens is there — and so is anything hidden.
 */
const openRegions = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    };
    const regions = Array.from(
      document.querySelectorAll(
        'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"],details[open],[data-state="open"],[data-open]',
      ),
    ).filter(
      (el) =>
        shown(el) && !el.matches('button,[role="button"],[aria-expanded],[aria-haspopup],summary'),
    );
    // Where each sits, so one region closing as another opens still reads as a change.
    return regions.map((el) => {
      const path: number[] = [];
      for (let n: Element | null = el; n?.parentElement; n = n.parentElement) {
        path.unshift(Array.from(n.parentElement.children).indexOf(n));
      }
      return `${el.tagName}:${path.join(".")}`;
    });
  });

const openedSince = (before: string[], now: string[]) => now.some((r) => !before.includes(r));

/**
 * Wait for the element a recipe names by id, as it was recorded, falling back to
 * "the click before it opened something". The id was right when the state was
 * recorded, but a site can generate it (a counter, React's useId) and give the same
 * dialog another one on this load; what the click does doesn't change.
 *
 * - A stable id gets the first few seconds to itself, so a region that takes a
 *   moment to fill (a menu loading its items) is still waited for. After that, a
 *   region the click opened is enough; with none, the wait carries on to its
 *   timeout and fails as it always did.
 * - An id already known to be generated is never there: the step gives the click a
 *   moment to open something and moves on, whatever it did.
 */
async function waitForIdOrOpened(
  page: Page,
  selector: string,
  generated: boolean,
  before: string[],
  timeout: number | undefined,
): Promise<void> {
  if (generated) {
    const end = Date.now() + GENERATED_ID_WAIT_MS;
    while (Date.now() < end) {
      if (openedSince(before, await openRegions(page).catch(() => []))) return;
      await page.waitForTimeout(100);
    }
    return;
  }
  const wait = (ms: number | undefined) =>
    visibleMatch(page, selector).waitFor({ state: "visible", timeout: ms });
  // No timeout of its own: the page's default applies to what's left.
  const limit = timeout;
  const grace = Math.min(ID_GRACE_MS, limit ?? ID_GRACE_MS);
  try {
    await wait(grace);
    return;
  } catch (e) {
    if (openedSince(before, await openRegions(page).catch(() => []))) return;
    if (limit !== undefined && limit <= grace) throw e;
  }
  await wait(limit === undefined ? undefined : limit - grace);
}

/**
 * A `waitFor` step on a selector. "Visible" holds once any match is visible;
 * the other states keep their first-match meaning.
 */
function waitStep(
  page: Page,
  selector: string,
  state: "visible" | "hidden" | "attached" | "detached" | undefined,
  timeout: number | undefined,
): Promise<void> {
  const s = state ?? "visible";
  const loc = s === "visible" ? visibleMatch(page, selector) : page.locator(selector).first();
  return loc.waitFor({ state: s, timeout });
}

/** Replay an ordered list of interaction steps on a page. */
export async function applyRecipe(page: Page, steps: RecipeStep[]): Promise<void> {
  /** What was open just before the step a following id-wait depends on. */
  let before: string[] | undefined;
  for (const [i, step] of steps.entries()) {
    const next = steps[i + 1];
    if (
      (step.action === "click" || step.action === "hover" || step.action === "press") &&
      next?.action === "waitFor" &&
      next.selector &&
      (next.state ?? "visible") === "visible" &&
      idOfSelector(next.selector) !== undefined
    ) {
      before = await openRegions(page).catch(() => undefined);
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
          await waitStep(page, step.selector, step.state, GENERATED_ID_WAIT_MS).catch(() => {});
        } else if (step.selector) await waitStep(page, step.selector, step.state, step.timeoutMs);
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
