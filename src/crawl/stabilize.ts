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

/** Quiet the page down right before a screenshot. */
export async function stabilizePage(page: Page, stab: Stabilize): Promise<void> {
  if (stab.animations === "disabled") {
    await page
      .addStyleTag({
        content: `*,*::before,*::after{transition:none!important;animation:none!important;animation-duration:0s!important;animation-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}`,
      })
      .catch(() => {});
  }
  if (stab.waitForFonts) {
    await page.evaluate(() => (document.fonts ? document.fonts.ready.then(() => undefined) : undefined)).catch(() => {});
  }
  if (stab.lazyScroll) {
    await autoScroll(page).catch(() => {});
  }
  if (stab.extraDelayMs > 0) {
    await page.waitForTimeout(stab.extraDelayMs);
  }
}
