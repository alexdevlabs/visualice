import type { BrowserContext, Page } from "playwright";
import type { Config } from "../shared/config";

type Stabilize = Config["stabilize"];

function buildInitScript(frozenMs: number | null, seed: number | null): string {
  return `(() => {
  const FROZEN = ${frozenMs === null ? "null" : frozenMs};
  const SEED = ${seed === null ? "null" : seed};
  if (FROZEN !== null) {
    const RealDate = Date;
    const FakeDate = function (...args) {
      if (args.length === 0) return new RealDate(FROZEN);
      return new RealDate(...args);
    };
    FakeDate.now = () => FROZEN;
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    try { window.Date = FakeDate; } catch (e) {}
    // NOTE: performance.now() is intentionally NOT frozen. It's the monotonic
    // animation clock; pinning it to a constant makes rAF/timeout loops that wait
    // on elapsed time hang forever (→ navigation timeout, blank screenshot).
    // Wall-clock determinism only needs Date frozen; CSS animations are disabled
    // separately in stabilizePage().
  }
  if (SEED !== null) {
    let s = SEED >>> 0;
    Math.random = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
})();`;
}

/** Install determinism shims (frozen clock, seeded RNG) before any page script runs. */
export async function applyContextInit(context: BrowserContext, stab: Stabilize): Promise<void> {
  // tsx/esbuild "keepNames" wraps named functions with a `__name(fn, "name")` helper.
  // When Playwright serializes a page.evaluate callback into the browser, that helper
  // isn't defined there — so polyfill it as a passthrough before any navigation.
  await context.addInitScript({
    content: "globalThis.__name = globalThis.__name || function (t) { return t; };",
  });

  const parsed = stab.freezeTime ? Date.parse(stab.freezeTime) : NaN;
  const frozen = Number.isNaN(parsed) ? null : parsed;
  const seed = typeof stab.seedRandom === "number" ? stab.seedRandom : null;
  if (frozen !== null || seed !== null) {
    await context.addInitScript({ content: buildInitScript(frozen, seed) });
  }
}

async function autoScroll(page: Page): Promise<void> {
  // Scroll the window AND the largest inner scroll container — many app shells
  // keep the body at 100vh and scroll content inside a child element, where a
  // window-only scroll never triggers lazy-loaded content.
  await page.evaluate(async () => {
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const root = document.scrollingElement || document.documentElement;

    let inner: Element | null = null;
    let innerExtra = 0;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const s = getComputedStyle(el);
      if (!/(auto|scroll)/.test(s.overflowY)) continue;
      const extra = el.scrollHeight - el.clientHeight;
      if (extra > innerExtra && el.clientHeight > 200) {
        innerExtra = extra;
        inner = el;
      }
    }

    const targets: Element[] = [root];
    if (inner && inner !== root) targets.push(inner);
    for (const sc of targets) {
      let prev = -1;
      for (let i = 0; i < 40 && sc.scrollTop !== prev; i++) {
        prev = sc.scrollTop;
        sc.scrollTop = sc.scrollHeight;
        await wait(40);
      }
      sc.scrollTop = 0;
    }
  });
  await page.waitForTimeout(120);
}

/** The part of a Playwright page this waiter needs, so a test can stand one in. */
type Waitable = Pick<Page, "locator">;

/**
 * Wait for the page's own "ready" markers, all of them sharing one budget.
 *
 * The waits run concurrently rather than one after another, which is what makes a
 * single budget honest: eight selectors waited on in sequence cost eight timeouts
 * on every shot — 40s of a 5s-per-selector budget — and the eighth selector is
 * made to look stale by the seven ahead of it. Started together, the ones that are
 * there resolve immediately and only the genuinely absent ones reach the deadline,
 * once, together.
 *
 * Returns the selectors that never appeared, so the caller can say so: silently
 * absorbing one would add its timeout to every shot with nothing in the output to
 * explain why the run got slower.
 */
export async function waitForStableSelectors(
  page: Waitable,
  selectors: string[],
  budgetMs: number,
): Promise<string[]> {
  if (!selectors.length) return [];
  const deadline = Date.now() + budgetMs;
  const results = await Promise.all(
    selectors.map(async (selector) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return selector;
      try {
        await page.locator(selector).first().waitFor({ state: "visible", timeout: remaining });
        return null;
      } catch {
        return selector;
      }
    }),
  );
  return results.filter((s): s is string => s !== null);
}

/**
 * Quiet the page down right before a screenshot.
 *
 * `log` is optional so callers that don't care stay terse, but a `waitForSelectors`
 * entry that never appears is worth saying out loud: silently absorbing it would
 * add its timeout to every single shot with nothing in the output to explain why
 * the run got slower.
 */
export async function stabilizePage(
  page: Page,
  stab: Stabilize,
  log?: (msg: string) => void,
): Promise<void> {
  // The page's own "I'm ready" markers (hints.stableSelectors / config) beat any
  // fixed delay: wait for them before spending time on the rest.
  const missing = await waitForStableSelectors(
    page,
    stab.waitForSelectors,
    stab.waitForSelectorsTimeoutMs,
  );
  for (const selector of missing) {
    log?.(`  ⚠ waitForSelectors: "${selector}" never became visible — continuing`);
  }
  if (stab.animations === "disabled") {
    await page
      .addStyleTag({
        content: `*,*::before,*::after{transition:none!important;animation:none!important;animation-duration:0s!important;animation-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}`,
      })
      .catch(() => {});
  }
  if (stab.waitForFonts) {
    await page
      .evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined))
      .catch(() => {});
  }
  if (stab.lazyScroll) {
    await autoScroll(page).catch(() => {});
  }
  if (stab.extraDelayMs > 0) {
    await page.waitForTimeout(stab.extraDelayMs);
  }
}
