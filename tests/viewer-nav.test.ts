import { describe, expect, it } from "vitest";
import { nextTileId } from "../viewer/src/nav";
import type { Placed } from "../viewer/src/layout";

/**
 * The heights here are the point: a full-page mobile shot beside a desktop one is
 * many times taller, and any metric based on tile centres picks a tile in the next
 * section over rather than the neighbour you can see.
 */
const placed = (id: string, x: number, y: number, w: number, h: number): Placed => ({
  tile: {
    id,
    routeId: "r",
    routeUrl: "/",
    routePath: "home",
    stateId: "s",
    stateLabel: "s",
    stateKind: "default",
    device: "d",
    full: "f.png",
  },
  x,
  y,
  w,
  h,
  cropped: false,
});

// Two sections side by side. Within each, a short desktop tile and a very tall
// mobile tile share a row.
const layout: Placed[] = [
  placed("a-desktop", 0, 0, 300, 500),
  placed("a-mobile", 330, 0, 80, 1120),
  placed("b-desktop", 500, 0, 300, 500),
  placed("b-mobile", 830, 0, 80, 1120),
  placed("a-desktop-2", 0, 1200, 300, 500),
];

describe("nextTileId", () => {
  it("steps to the neighbour in the same row, not the next section", () => {
    expect(nextTileId(layout, "a-desktop", 1, 0)).toBe("a-mobile");
    expect(nextTileId(layout, "a-mobile", 1, 0)).toBe("b-desktop");
  });

  it("steps back the way it came", () => {
    expect(nextTileId(layout, "b-desktop", -1, 0)).toBe("a-mobile");
    expect(nextTileId(layout, "a-mobile", -1, 0)).toBe("a-desktop");
  });

  it("moves down a column", () => {
    expect(nextTileId(layout, "a-desktop", 0, 1)).toBe("a-desktop-2");
    expect(nextTileId(layout, "a-desktop-2", 0, -1)).toBe("a-desktop");
  });

  it("stops at the edge instead of wrapping", () => {
    expect(nextTileId(layout, "a-desktop", -1, 0)).toBeUndefined();
    expect(nextTileId(layout, "b-mobile", 1, 0)).toBeUndefined();
  });

  it("selects the first tile when nothing is selected yet", () => {
    expect(nextTileId(layout, null, 1, 0)).toBe("a-desktop");
    expect(nextTileId(layout, "gone", 0, 1)).toBe("a-desktop");
  });

  it("has nothing to do on an empty canvas", () => {
    expect(nextTileId([], null, 1, 0)).toBeUndefined();
  });
});
