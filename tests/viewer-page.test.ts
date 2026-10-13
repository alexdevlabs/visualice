import { describe, expect, it } from "vitest";
import { chromeAt, maxScroll, pageOf } from "../viewer/src/page";

/** Three 100px screens taken 60px apart, a 20px sticky header and a 10px bottom bar. */
const pinned = {
  width: 50,
  height: 300,
  screens: 3,
  frames: [
    { y: 0, top: 20, bottom: 10 },
    { y: 60, top: 20, bottom: 10 },
    { y: 120, top: 20, bottom: 10 },
  ],
};

describe("pageOf", () => {
  it("keeps the header from the first screen and the bottom bar from the last", () => {
    // Each seam is 5 rows from the nearest bar, never against one.
    const page = pageOf(pinned)!;
    expect(page.strips).toEqual([
      // Screen 1: header and content, stopping short of the bottom bar.
      { src: 0, at: 0, len: 85 },
      // Screen 2: picks up halfway through the 10 rows both screens showed below the
      // header, so the seam sits in page content rather than against a bar.
      { src: 100 + 25, at: 85, len: 60 },
      // Screen 3: the rest of the page, bottom bar included.
      { src: 200 + 25, at: 145, len: 75 },
    ]);
    expect(page.height).toBe(220);
    expect(page.viewH).toBe(100);
  });

  it("lays screens end to end when no frames were recorded", () => {
    const page = pageOf({ width: 50, height: 300, screens: 3 })!;
    expect(page.strips).toEqual([
      { src: 0, at: 0, len: 100 },
      { src: 100, at: 100, len: 100 },
      { src: 200, at: 200, len: 100 },
    ]);
    expect(page.height).toBe(300);
  });

  it("measures pages from the first screen, wherever the scroller started", () => {
    const shifted = { ...pinned, frames: pinned.frames.map((f) => ({ ...f, y: f.y - 40 })) };
    expect(pageOf(shifted)!.strips).toEqual(pageOf(pinned)!.strips);
  });

  it("drops a screen with nothing new on it", () => {
    const page = pageOf({
      width: 50,
      height: 200,
      screens: 2,
      frames: [
        { y: 0, top: 0, bottom: 0 },
        { y: 0, top: 0, bottom: 0 },
      ],
    })!;
    expect(page.strips).toEqual([{ src: 0, at: 0, len: 100 }]);
  });

  it("scrolls a single tall image one window at a time", () => {
    const page = pageOf({ width: 50, height: 400 }, 120)!;
    expect(page.strips).toEqual([{ src: 0, at: 0, len: 400 }]);
    expect(page.viewH).toBe(120);
    expect(maxScroll(page)).toBe(280);
    // Shorter than the window: nothing to scroll.
    expect(maxScroll(pageOf({ width: 50, height: 80 }, 120)!)).toBe(0);
  });

  it("has nothing to show without an image size", () => {
    expect(pageOf({ width: 50 })).toBeUndefined();
  });
});

describe("chromeAt", () => {
  it("takes the pinned bars from the last screen captured at or above the position", () => {
    const page = pageOf(pinned)!;
    expect(maxScroll(page)).toBe(120);
    expect(chromeAt(page, 0)?.src).toBe(0);
    expect(chromeAt(page, 59)?.src).toBe(0);
    expect(chromeAt(page, 60)?.src).toBe(100);
    expect(chromeAt(page, 120)?.src).toBe(200);
  });
});
