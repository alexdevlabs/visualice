import type { Locator, Page } from "playwright";

/**
 * Capturing a page the way a user sees it: one screen at a time.
 *
 * A full-page render pretends the window is as tall as the document, which no
 * user ever sees. Anything pinned to the window — a cookie bar, a modal's
 * backdrop, a `100vh` section — then has nowhere honest to go: the bar lands once
 * mid-page and the backdrop stops after the first screen. Scrolling and taking an
 * ordinary viewport screenshot at each stop leaves the page untouched and shows
 * every pinned element where the browser really draws it.
 */

export interface ScreensOptions {
  /** Stop once this much of the page (CSS px from the top) is covered; 0 = no limit. */
  maxHeight: number;
  /** Deprecated extra limit on the number of screens. */
  maxScreens?: number;
  /** Settle time after each scroll, before the next screen is taken. */
  settleMs: number;
  type: "png" | "jpeg";
  quality?: number;
  mask?: Locator[];
  /** Take one screen where the page already is: a recipe scrolled there on purpose. */
  keepScroll?: boolean;
}

export interface Screens {
  frames: Buffer[];
  /**
   * Where each frame sat on the page, in CSS px: the page position at its first
   * row, and the rows pinned bars covered at its top and bottom. Absent for a
   * single screen, which has nothing to join.
   */
  stops?: { y: number; top: number; bottom: number }[];
  /** The window's height in CSS px, which `stops` are measured against. */
  viewportHeight?: number;
  /** The page went on past `maxHeight` (or `maxScreens`). */
  clamped: boolean;
}

/**
 * Scrolled content shared between consecutive screens, in CSS px — so a line of
 * text cut at one screen's edge is whole on the next.
 */
const OVERLAP = 40;

/** What a screen can see from where it is, and how far the next one may move. */
interface Stop {
  pos: number;
  max: number;
  /** Viewport px covered at the top and bottom by bars pinned to the window. */
  top: number;
  bottom: number;
  height: number;
  /** Where the scroller's box starts in the window, and the window's height. */
  boxTop: number;
  vh: number;
}

/**
 * Read-only, run in the page: where the scroller is, and how much of the screen
 * fixed or sticky bars hide. A step of the full screen height would put the strip
 * under a pinned header in no screen at all; stepping by what's left visible
 * shows every part of the page uncovered at least once.
 */
async function measure(page: Page): Promise<Stop> {
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const scroller = (window as unknown as { __vcScroller?: Element }).__vcScroller;
    const sc = scroller ?? document.scrollingElement ?? document.documentElement;
    const box = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: vh };
    const height = Math.min(vh, box.bottom) - Math.max(0, box.top);
    let top = 0;
    let bottom = 0;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const s = getComputedStyle(el);
      if (s.position !== "fixed" && s.position !== "sticky") continue;
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      // A backdrop or a full-height drawer covers the screen rather than an edge of
      // it; there is no uncovered strip to step around.
      if (r.width === 0 || r.height === 0 || r.height > height / 2) continue;
      if (r.bottom <= box.top || r.top >= box.bottom) continue;
      if (r.top <= box.top + 1) top = Math.max(top, r.bottom - box.top);
      else if (r.bottom >= box.bottom - 1) bottom = Math.max(bottom, box.bottom - r.top);
    }
    return {
      pos: sc.scrollTop,
      max: Math.max(0, sc.scrollHeight - sc.clientHeight),
      top,
      bottom,
      height,
      boxTop: box.top,
      vh,
    };
  });
}

/**
 * A stop as the window saw it. Chrome outside an inner scroller (an app shell's
 * header and footer) covers the screen exactly like a pinned bar, and a window row
 * `v` shows the page at `y + v`.
 */
function frameOf(stop: Stop): { y: number; top: number; bottom: number } {
  const above = Math.max(0, stop.boxTop);
  const below = Math.max(0, stop.vh - stop.height - above);
  const top = Math.min(stop.vh, above + stop.top);
  const bottom = Math.min(stop.vh - top, below + stop.bottom);
  return { y: stop.pos - stop.boxTop, top, bottom };
}

/**
 * Pick what scrolls: the window when it can, otherwise the largest inner scroll
 * container (an app shell keeps the body at 100vh and scrolls a child). A page
 * whose scrolling is locked — an open modal usually does this — gets no scroller,
 * and so exactly one screen, which is all a user can see of it.
 */
async function pickScroller(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const w = window as unknown as { __vcScroller?: Element };
    delete w.__vcScroller;
    const canScroll = (el: Element) => {
      const before = el.scrollTop;
      el.scrollTop = before + 1;
      const moved = el.scrollTop !== before;
      el.scrollTop = before;
      return moved;
    };
    // `overflow: hidden` stops the user, not a script: scrollTop still moves the
    // page, so a scroll lock is read from the style. The window takes its overflow
    // from <html>, or from <body> when <html> leaves it visible.
    const locked = (el: Element) => /(hidden|clip)/.test(getComputedStyle(el).overflowY);
    const html = document.documentElement;
    const rootLocked =
      locked(html) || (getComputedStyle(html).overflowY === "visible" && locked(document.body));
    const root = document.scrollingElement ?? html;
    if (rootLocked) return false;
    if (root.scrollHeight > root.clientHeight && canScroll(root)) return true;
    let best: Element | null = null;
    let extra = 0;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      const more = el.scrollHeight - el.clientHeight;
      if (more > extra && el.clientHeight > 200 && canScroll(el)) {
        extra = more;
        best = el;
      }
    }
    if (best) w.__vcScroller = best;
    return best !== null;
  });
}

async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((top) => {
    const scroller = (window as unknown as { __vcScroller?: Element }).__vcScroller;
    const sc = scroller ?? document.scrollingElement ?? document.documentElement;
    sc.scrollTop = top;
  }, y);
}

/** Images that scrolled into view get a moment to arrive before the screen is taken. */
async function settle(page: Page, ms: number): Promise<void> {
  await page
    .evaluate(
      (budget) =>
        Promise.race([
          Promise.all(
            Array.from(document.images)
              .filter((img) => !img.complete)
              .map((img) => new Promise((r) => img.addEventListener("loadend", r, { once: true }))),
          ),
          new Promise((r) => setTimeout(r, budget)),
        ]).then(() => undefined),
      2000,
    )
    .catch(() => {});
  if (ms > 0) await page.waitForTimeout(ms);
}

export async function captureScreens(page: Page, opts: ScreensOptions): Promise<Screens> {
  const shoot = () =>
    page.screenshot({
      type: opts.type,
      quality: opts.type === "jpeg" ? opts.quality : undefined,
      mask: opts.mask?.length ? opts.mask : undefined,
    });

  const scrolls = !opts.keepScroll && (await pickScroller(page).catch(() => false));
  if (!scrolls) return { frames: [await shoot()], clamped: false };

  await scrollTo(page, 0);
  await settle(page, opts.settleMs);
  const frames: Buffer[] = [];
  const stops: Stop[] = [];
  let clamped = false;
  try {
    for (;;) {
      frames.push(await shoot());
      const stop = await measure(page);
      stops.push(stop);
      if (stop.pos >= stop.max - 1) break;
      const covered = stop.pos + stop.height;
      if (
        (opts.maxHeight > 0 && covered >= opts.maxHeight) ||
        (opts.maxScreens !== undefined && frames.length >= opts.maxScreens)
      ) {
        clamped = true;
        break;
      }
      const visible = stop.height - stop.top - stop.bottom - OVERLAP;
      const step = Math.max(Math.round(stop.height / 3), visible);
      await scrollTo(page, Math.min(stop.max, stop.pos + step));
      await settle(page, opts.settleMs);
      // A page that refuses to move (scroll snapping, a script pinning it) would
      // otherwise repeat the same screen up to the limit.
      if ((await measure(page)).pos <= stop.pos) break;
    }
  } finally {
    // The next state may reuse this page; leave it where a fresh load would be.
    await scrollTo(page, 0).catch(() => {});
  }
  if (frames.length < 2) return { frames, clamped };
  return { frames, stops: stops.map(frameOf), viewportHeight: stops[0].vh, clamped };
}
