import { describe, it, expect } from "vitest";
import {
  cullTiles,
  cullLabels,
  lodFor,
  visibleWorldRect,
  FULL_RES_WIDTH_PX,
} from "../viewer/src/lod";
import type { Placed, GroupLabel } from "../viewer/src/layout";

const vp = { w: 1000, h: 800 };
const at = (scale: number, x = 0, y = 0) => ({ scale, x, y });

const placed = (id: string, x: number, y: number, w = 300, h = 400): Placed => ({
  tile: {
    id,
    routeId: "r",
    routeUrl: "/",
    routePath: "home",
    stateId: "default",
    stateLabel: "Default",
    stateKind: "default",
    device: "desktop",
    full: `${id}.png`,
    thumb: `${id}.webp`,
  },
  x,
  y,
  w,
  h,
  cropped: false,
});

describe("visibleWorldRect", () => {
  it("maps the screen rect into world space", () => {
    const r = visibleWorldRect(at(1), vp);
    expect(r.x0).toBeCloseTo(0);
    expect(r.y0).toBeCloseTo(0);
    expect(r.x1).toBe(1000);
    expect(r.y1).toBe(800);
  });

  it("grows the world rect as you zoom out, and follows panning", () => {
    const zoomedOut = visibleWorldRect(at(0.5), vp);
    expect(zoomedOut.x1).toBe(2000); // half scale ⇒ twice the world visible
    const panned = visibleWorldRect(at(1, -200, -100), vp);
    expect(panned.x0).toBe(200);
    expect(panned.y0).toBe(100);
  });

  it("expresses the margin in screen px regardless of zoom", () => {
    expect(visibleWorldRect(at(2), vp, 400).x0).toBe(-200);
    expect(visibleWorldRect(at(0.5), vp, 400).x0).toBe(-800);
  });
});

describe("cullTiles", () => {
  const tiles = [
    placed("in-view", 100, 100),
    placed("just-off-right", 1200, 100), // inside the 400px margin
    placed("far-right", 5000, 100),
    placed("far-below", 100, 9000),
  ];

  it("keeps on-screen tiles and those within the margin, drops the rest", () => {
    const ids = cullTiles(tiles, at(1), vp).map((p) => p.tile.id);
    expect(ids).toContain("in-view");
    expect(ids).toContain("just-off-right");
    expect(ids).not.toContain("far-right");
    expect(ids).not.toContain("far-below");
  });

  it("keeps a tile that only partially intersects the viewport", () => {
    const straddling = [placed("straddle", -100, -100)];
    expect(cullTiles(straddling, at(1), vp, 0)).toHaveLength(1);
  });

  it("pulls more tiles in as you zoom out", () => {
    expect(cullTiles(tiles, at(0.1), vp).length).toBeGreaterThan(
      cullTiles(tiles, at(1), vp).length,
    );
  });
});

describe("cullLabels", () => {
  const labels: GroupLabel[] = [
    { routeId: "a", title: "A", subtitle: "", x: 0, y: 0, w: 900 },
    { routeId: "b", title: "B", subtitle: "", x: 0, y: 4000, w: 900 },
  ];

  it("keeps only headers near the viewport", () => {
    expect(cullLabels(labels, at(1), vp).map((l) => l.routeId)).toEqual(["a"]);
    expect(cullLabels(labels, at(1, 0, -3900), vp).map((l) => l.routeId)).toEqual(["b"]);
  });
});

describe("lodFor", () => {
  const tile = { full: "full.png", thumb: "thumb.webp" };

  it("draws the thumbnail while the tile is small on screen", () => {
    expect(lodFor(tile, 200)).toBe("thumb.webp");
    expect(lodFor(tile, FULL_RES_WIDTH_PX)).toBe("thumb.webp");
  });

  it("swaps to full resolution once the tile is big enough to show detail", () => {
    expect(lodFor(tile, FULL_RES_WIDTH_PX + 1)).toBe("full.png");
    expect(lodFor(tile, 4000)).toBe("full.png");
  });

  it("falls back to the full image when no thumbnail exists", () => {
    expect(lodFor({ full: "full.png" }, 10)).toBe("full.png");
  });
});
