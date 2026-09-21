import { describe, expect, it } from "vitest";
import { rowRange } from "../viewer/src/virtual-list";

const ROW = 44;

describe("rowRange", () => {
  it("renders nothing for an empty list", () => {
    expect(rowRange(0, 500, ROW, 0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
  });

  it("starts at the top with no padding above it", () => {
    const r = rowRange(0, 440, ROW, 500);
    expect(r.start).toBe(0);
    expect(r.padTop).toBe(0);
    expect(r.end).toBeGreaterThan(10); // the ten on screen, plus overscan
  });

  it("renders far fewer rows than the list has", () => {
    const r = rowRange(0, 440, ROW, 1000);
    expect(r.end - r.start).toBeLessThan(40);
  });

  it("keeps the scrollbar the size the full list would give it", () => {
    const count = 1000;
    const r = rowRange(4400, 440, ROW, count);
    expect(r.padTop + (r.end - r.start) * ROW + r.padBottom).toBe(count * ROW);
  });

  it("follows the scroll position", () => {
    const top = rowRange(0, 440, ROW, 1000);
    const middle = rowRange(10_000, 440, ROW, 1000);
    expect(middle.start).toBeGreaterThan(top.end);
    expect(middle.start).toBe(Math.floor(10_000 / ROW) - 6);
  });

  it("keeps rows on each side of the viewport, so a fast scroll isn't blank", () => {
    const r = rowRange(10_000, 440, ROW, 1000);
    const firstOnScreen = Math.floor(10_000 / ROW);
    expect(r.start).toBeLessThan(firstOnScreen);
    expect(r.end).toBeGreaterThan(firstOnScreen + Math.ceil(440 / ROW));
  });

  it("never runs past the end of the list", () => {
    const r = rowRange(1_000_000, 440, ROW, 20);
    expect(r.end).toBe(20);
    expect(r.start).toBeLessThan(20);
    expect(r.padBottom).toBe(0);
  });

  it("renders the whole list before the container has been measured", () => {
    // First paint has no height yet; rendering nothing would leave a panel that
    // never scrolls and so never gets a second chance.
    const r = rowRange(0, 0, ROW, 30);
    expect(r).toEqual({ start: 0, end: 30, padTop: 0, padBottom: 0 });
  });

  it("treats a negative scroll (rubber-banding) as the top", () => {
    expect(rowRange(-200, 440, ROW, 100).start).toBe(0);
  });
});
