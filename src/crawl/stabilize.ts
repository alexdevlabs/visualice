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
    try { performance.now = () => 0; } catch (e) {}
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
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let total = 0;
      const step = Math.max(200, Math.round(window.innerHeight * 0.8));
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight + window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 40);
    });
  });
  await page.waitForTimeout(120);
  await page.evaluate(() => window.scrollTo(0, 0));
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
