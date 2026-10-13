/**
 * A shot as one page, built from the screens it was taken in.
 *
 * Continuous and Scroll mode both show the page rather than the screens, and the
 * picture is never edited to get there: each screen contributes the strip of rows
 * that are new page, read straight out of the stacked image. A bar pinned to the
 * window covers the same rows of every screen, so the rows it covers are left out
 * of every screen but the one where it belongs — the header with the first, a
 * bottom bar with the last. All numbers are in image px.
 */
import type { ViewerTile } from "./types";

/** Rows `src`..`src + len` of the image, drawn at page position `at`. */
export interface Strip {
  src: number;
  at: number;
  len: number;
}

/** A pinned bar's rows in one screen, and the page positions that screen shows. */
export interface Chrome {
  /** Page position at the screen's first row, relative to the page's top. */
  at: number;
  /** Image row where the screen starts. */
  src: number;
  top: number;
  bottom: number;
}

export interface PageModel {
  strips: Strip[];
  /** The page's height: where the last strip ends. */
  height: number;
  /** One screen's height — what Scroll mode shows at a time. */
  viewH: number;
  /** Per screen, top to bottom; empty for a single image. */
  chrome: Chrome[];
}

/**
 * The page a tile shows. `viewportH` is the device's window height in image px,
 * used to scroll a single tall image (a capture taken in one render).
 */
export function pageOf(
  tile: Pick<ViewerTile, "width" | "height" | "screens" | "frames">,
  viewportH?: number,
): PageModel | undefined {
  const imgH = tile.height;
  if (!imgH || imgH <= 0) return undefined;
  const n = tile.screens ?? 1;
  if (n < 2) {
    const viewH = Math.min(imgH, viewportH && viewportH > 0 ? viewportH : imgH);
    return { strips: [{ src: 0, at: 0, len: imgH }], height: imgH, viewH, chrome: [] };
  }
  const screenH = imgH / n;
  // A run from before frames were recorded: the screens can only be laid end to end.
  const frames =
    tile.frames?.length === n
      ? tile.frames
      : Array.from({ length: n }, (_, i) => ({ y: i * screenH, top: 0, bottom: 0 }));
  const y0 = frames[0].y;
  const strips: Strip[] = [];
  let end = -Infinity;
  frames.forEach((f, i) => {
    let from = i === 0 ? 0 : f.top;
    const to = i === n - 1 ? screenH : screenH - f.bottom;
    // Rows the screen above already showed (the overlap between scroll stops).
    const shown = end - f.y;
    if (shown > from && to - shown >= 1) {
      // Cut in the middle of the overlap, not where a pinned bar starts: a scaled
      // image blends each edge row with the rows past it, and a bar's border there
      // draws a gray line across the seam. Mid-overlap, both sides are the same page.
      const back = Math.floor((shown - from) / 2);
      strips[strips.length - 1].len -= back;
      from = shown - back;
    } else {
      from = Math.max(from, shown);
    }
    if (to - from < 1) return;
    strips.push({ src: i * screenH + from, at: f.y - y0 + from, len: to - from });
    end = f.y + to;
  });
  const last = strips[strips.length - 1];
  return {
    strips,
    height: last.at + last.len,
    viewH: screenH,
    chrome: frames.map((f, i) => ({
      at: f.y - y0,
      src: i * screenH,
      top: f.top,
      bottom: f.bottom,
    })),
  };
}

/** How far Scroll mode can scroll the page. */
export function maxScroll(page: PageModel): number {
  return Math.max(0, page.height - page.viewH);
}

/**
 * The screen whose pinned bars show at scroll position `s`: the last one taken at
 * or above it, so the bars match what the window really had there.
 */
export function chromeAt(page: PageModel, s: number): Chrome | undefined {
  let found: Chrome | undefined;
  for (const c of page.chrome) {
    if (c.at <= s + 0.5) found = c;
    else break;
  }
  return found;
}
