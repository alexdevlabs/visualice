import { describe, it, expect } from "vitest";
import { columnCount, computeLayout, tileHeight } from "../viewer/src/layout";
import type { ViewerData, ViewerTile } from "../viewer/src/types";

const DEVICES = [
  { name: "desktop", width: 1440, height: 900, dpr: 2 },
  { name: "mobile", width: 390, height: 844, dpr: 3 },
];

function tile(routeId: string, stateId: string, device: string, extra: Partial<ViewerTile> = {}) {
  return {
    id: `${routeId}__${stateId}__${device}`,
    routeId,
    routeUrl: routeId === "home" ? "/" : `/${routeId}`,
    routePath: routeId === "home" ? "home" : routeId,
    stateId,
    stateLabel: stateId,
    stateKind: stateId === "default" ? "default" : "modal",
    device,
    full: `screenshots/${routeId}/${stateId}/${device}.png`,
    thumb: `screenshots/${routeId}/${stateId}/${device}.thumb.webp`,
    width: 1000,
    height: 2000,
    ...extra,
  } satisfies ViewerTile;
}

const data: ViewerData = {
  site: { baseUrl: "https://x.test", origin: "https://x.test", runId: "r", generatedAt: "t" },
  devices: DEVICES,
  tiles: [
    tile("home", "default", "desktop"),
    tile("home", "default", "mobile"),
    tile("home", "modal-search", "desktop"),
    tile("home", "modal-search", "mobile"),
    tile("about", "default", "desktop"),
    tile("about", "default", "mobile"),
  ],
  groups: [
    { path: "home", routeId: "home", title: "Home" },
    { path: "about", routeId: "about", title: "About" },
  ],
};

const allDevices = new Set(["desktop", "mobile"]);

describe("computeLayout — grouped", () => {
  it("places every tile once and emits a header per route", () => {
    const l = computeLayout(data, { devices: allDevices });
    expect(l.placed).toHaveLength(6);
    expect(l.labels.map((x) => x.routeId)).toEqual(["home", "about"]);
    expect(l.labels[0].subtitle).toBe("2 states");
    expect(l.labels.map((x) => x.path)).toEqual(["/", "/about"]);
  });

  it("never overlaps two route sections", () => {
    const l = computeLayout(data, { devices: allDevices });
    const home = l.byRoute.get("home")!;
    const about = l.byRoute.get("about")!;
    // Separated on at least one axis — the sections may sit in one column or side
    // by side, but they never sit on top of each other.
    const apart = about.minY >= home.maxY || about.minX >= home.maxX;
    expect(apart).toBe(true);
  });

  it("puts devices side by side, widest device widest on canvas", () => {
    const l = computeLayout(data, { devices: allDevices });
    const row = l.placed.filter((p) => p.tile.stateId === "default" && p.tile.routeId === "home");
    const desktop = row.find((p) => p.tile.device === "desktop")!;
    const mobile = row.find((p) => p.tile.device === "mobile")!;
    expect(desktop.y).toBe(mobile.y);
    expect(desktop.w).toBeGreaterThan(mobile.w);
    expect(mobile.x).toBeGreaterThanOrEqual(desktop.x + desktop.w);
  });

  it("caps very tall shots and flags them as cropped", () => {
    const tall: ViewerData = {
      ...data,
      tiles: [tile("home", "default", "desktop", { width: 1000, height: 40000 })],
      groups: [{ path: "home", routeId: "home", title: "Home" }],
    };
    const [p] = computeLayout(tall, { devices: allDevices }).placed;
    expect(p.cropped).toBe(true);
    expect(p.h).toBeLessThanOrEqual(1120);
  });

  it("skips routes with no matching tiles instead of leaving a gap", () => {
    const l = computeLayout(data, { devices: allDevices, query: "about" });
    expect(l.labels.map((x) => x.routeId)).toEqual(["about"]);
    expect(l.placed.every((p) => p.tile.routeId === "about")).toBe(true);
  });
});

describe("computeLayout — filters", () => {
  it("honours the device filter", () => {
    const l = computeLayout(data, { devices: new Set(["mobile"]) });
    expect(l.placed).toHaveLength(3);
    expect(l.placed.every((p) => p.tile.device === "mobile")).toBe(true);
  });

  it("searches path, url, state id and label", () => {
    expect(computeLayout(data, { devices: allDevices, query: "modal" }).placed).toHaveLength(2);
    expect(computeLayout(data, { devices: allDevices, query: "/about" }).placed).toHaveLength(2);
    expect(computeLayout(data, { devices: allDevices, query: "nothing-here" }).placed).toHaveLength(
      0,
    );
  });

  it("returns usable bounds even when everything is filtered out", () => {
    const l = computeLayout(data, { devices: allDevices, query: "nothing-here" });
    expect(l.bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  });
});

describe("computeLayout — grouped columns", () => {
  /**
   * Grouped mode used to stack every route in one column, which made the canvas a
   * tall ribbon: "Fit" then had to zoom out to ~2% and the run was unreadable at
   * its default zoom. Sections now wrap into columns chosen to land near screen
   * aspect.
   */
  const manyRoutes: ViewerData = {
    ...data,
    tiles: Array.from({ length: 20 }, (_, i) => tile(`r${i}`, "default", "desktop")),
    groups: Array.from({ length: 20 }, (_, i) => ({ path: `r${i}`, routeId: `r${i}` })),
  };

  it("keeps the fitted canvas near screen aspect instead of a sliver", () => {
    const l = computeLayout(manyRoutes, { devices: new Set(["desktop"]) });
    const w = l.bounds.maxX - l.bounds.minX;
    const h = l.bounds.maxY - l.bounds.minY;
    expect(l.placed).toHaveLength(20);
    // A single column of 20 tall sections would be far narrower than it is tall.
    expect(w / h).toBeGreaterThan(0.4);
    expect(w / h).toBeLessThan(4);
  });

  it("gives every section its own column slot, never overlapping", () => {
    const l = computeLayout(manyRoutes, { devices: new Set(["desktop"]) });
    const boxes = [...l.byRoute.values()];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const disjoint =
          a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY;
        expect(disjoint).toBe(true);
      }
    }
  });

  it("falls back to a single column when there is only one section", () => {
    const l = computeLayout(data, { devices: allDevices, query: "about" });
    expect(l.labels).toHaveLength(1);
    expect(l.labels[0].x).toBe(0);
  });
});

describe("columnCount", () => {
  it("widens as the stack gets taller", () => {
    expect(columnCount(1000, 1000, 10)).toBe(1);
    expect(columnCount(10_000, 1000, 10)).toBe(4);
    expect(columnCount(40_000, 1000, 10)).toBe(8);
  });

  it("never asks for more columns than there are sections", () => {
    expect(columnCount(100_000, 100, 3)).toBe(3);
    expect(columnCount(100_000, 1000, 1)).toBe(1);
  });

  it("is safe on degenerate input", () => {
    expect(columnCount(0, 1000, 5)).toBe(1);
    expect(columnCount(1000, 0, 5)).toBe(1);
  });
});

describe("computeLayout — failures and limits", () => {
  it("places a failed capture instead of dropping it from the catalog", () => {
    const withFailure: ViewerData = {
      ...data,
      tiles: [
        tile("home", "default", "desktop"),
        { ...tile("home", "broken", "desktop"), full: undefined, error: "timeout exceeded" },
      ],
      groups: [{ path: "home", routeId: "home", title: "Home" }],
    };
    const l = computeLayout(withFailure, { devices: new Set(["desktop"]) });
    expect(l.placed).toHaveLength(2);
    const failed = l.placed.find((p) => p.tile.error)!;
    expect(failed.w).toBeGreaterThan(0);
    expect(failed.h).toBeGreaterThan(0);
  });

  it("filters by state kind", () => {
    const l = computeLayout(data, {
      devices: allDevices,
      kinds: new Set(["modal"]),
    });
    expect(l.placed).toHaveLength(2);
    expect(l.placed.every((p) => p.tile.stateKind === "modal")).toBe(true);
  });

  it("an empty kind filter means all kinds, not none", () => {
    const l = computeLayout(data, { devices: allDevices, kinds: new Set() });
    expect(l.placed).toHaveLength(6);
  });

  it("is one page when no page size is given", () => {
    const l = computeLayout(data, { devices: allDevices });
    expect(l.pages).toBe(1);
    expect(l.page).toBe(0);
    expect(l.order).toHaveLength(6);
  });

  it("splits into pages between states, keeping a state's devices together", () => {
    const l = computeLayout(data, { devices: allDevices, pageSize: 3 });
    // Rows hold two shots (one per device): a third would split the next row.
    expect(l.pages).toBe(3);
    expect(l.placed).toHaveLength(2);
    expect(l.order).toHaveLength(6);
    const pages = [0, 1, 2].map((page) =>
      computeLayout(data, { devices: allDevices, pageSize: 3, page }).placed.map((p) => p.tile),
    );
    expect(pages.flat()).toEqual(l.order);
    for (const tiles of pages)
      expect(new Set(tiles.map((t) => `${t.routeId} ${t.stateId}`)).size).toBe(1);
    expect(l.order.map((t) => l.pageOf.get(t.id))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("puts a row bigger than the page size on a page of its own", () => {
    const l = computeLayout(data, { devices: allDevices, pageSize: 1 });
    expect(l.pages).toBe(3);
    expect(l.placed).toHaveLength(2);
  });

  it("shows the last page when asked for one past the end", () => {
    const l = computeLayout(data, { devices: allDevices, pageSize: 3, page: 99 });
    expect(l.page).toBe(2);
    expect(l.placed).toHaveLength(2);
    expect(computeLayout(data, { devices: allDevices, pageSize: 3, page: -4 }).page).toBe(0);
  });

  it("labels a route split over pages with all its states", () => {
    const one = computeLayout(data, { devices: allDevices });
    const paged = computeLayout(data, { devices: allDevices, pageSize: 3, page: 0 });
    const label = paged.labels[0];
    expect(label.subtitle).toBe(one.labels.find((x) => x.routeId === label.routeId)!.subtitle);
  });

  it("is one page when everything fits", () => {
    expect(computeLayout(data, { devices: allDevices, pageSize: 99 }).pages).toBe(1);
  });
});

describe("computeLayout — one route", () => {
  it("places only that route, while still listing the others for the sidebar", () => {
    const l = computeLayout(data, { devices: allDevices, routeId: "about" });
    expect(new Set(l.placed.map((p) => p.tile.routeId))).toEqual(new Set(["about"]));
    expect(l.routesWithTiles).toEqual(["home", "about"]);
  });

  it("titles the route in a heading for the header instead of on the canvas", () => {
    const l = computeLayout(data, { devices: allDevices, routeId: "about" });
    expect(l.labels).toEqual([]);
    expect(l.heading).toMatchObject({ routeId: "about", path: "/about", subtitle: "1 state" });
    // Only the tile captions need room above the shots.
    expect(Math.min(...l.placed.map((p) => p.y))).toBe(44);
  });

  it("keeps the canvas label when a search leaves one route in the all-routes view", () => {
    const l = computeLayout(data, { devices: allDevices, query: "about" });
    expect(l.heading).toBeUndefined();
    expect(l.labels.map((x) => x.routeId)).toEqual(["about"]);
  });

  it("places nothing when the filters leave that route empty", () => {
    const l = computeLayout(data, { devices: allDevices, routeId: "about", query: "modal" });
    expect(l.placed).toEqual([]);
    expect(l.routesWithTiles).toEqual(["home"]);
  });
});

describe("computeLayout — routesWithTiles", () => {
  it("lists the routes the filters left, in the data's order", () => {
    const l = computeLayout(data, { devices: allDevices });
    expect(l.routesWithTiles).toEqual(["home", "about"]);
    const filtered = computeLayout(data, { devices: allDevices, query: "modal" });
    expect(filtered.routesWithTiles).toEqual(["home"]);
  });
});

describe("tileHeight — modes", () => {
  const stacked = tile("home", "default", "desktop", {
    width: 1000,
    height: 3000,
    screens: 3,
    frames: [
      { y: 0, top: 100, bottom: 0 },
      { y: 800, top: 100, bottom: 0 },
      { y: 1600, top: 100, bottom: 0 },
    ],
  });

  it("draws each screen with a gap between them in Screen mode", () => {
    const s = tileHeight(stacked, 100);
    expect(s.screensShown).toBe(3);
    expect(s.h).toBeCloseTo(300 + 2 * 20);
    expect(s.page).toBeUndefined();
  });

  it("joins the screens into one shorter page in Continuous mode", () => {
    const s = tileHeight(stacked, 100, "continuous");
    // 1000 + 800 + 800 image rows: each later screen loses its overlap with the one before.
    expect(s.page?.height).toBe(2600);
    expect(s.h).toBeCloseTo(260);
    expect(s.k).toBeCloseTo(0.1);
  });

  it("is one screen tall in Scroll mode", () => {
    expect(tileHeight(stacked, 100, "scroll").h).toBeCloseTo(100);
  });

  it("scrolls a single image one device window at a time", () => {
    const single = tile("home", "default", "desktop", { width: 1000, height: 4000 });
    expect(tileHeight(single, 100, "scroll", 625).h).toBeCloseTo(62.5);
  });

  it("cuts a tall shot at whole screens, unless asked for all of it (full screen)", () => {
    const tall = tile("home", "default", "mobile", { width: 390, height: 6 * 844, screens: 6 });
    const capped = tileHeight(tall, 360);
    expect(capped.screensShown).toBeLessThan(6);
    expect(capped.cropped).toBe(true);
    const whole = tileHeight(tall, 360, "screen", undefined, Infinity);
    expect(whole.screensShown).toBe(6);
    expect(whole.cropped).toBe(false);
  });

  it("keeps a failed capture's placeholder in every mode", () => {
    const failed = tile("home", "default", "desktop", { error: "boom", screens: 3 });
    expect(tileHeight(failed, 100, "scroll").page).toBeUndefined();
  });
});

describe("computeLayout — modes", () => {
  it("sizes a single shot's scroll window from its device", () => {
    const layout = computeLayout(data, {
      devices: new Set(["desktop"]),
      mode: "scroll",
      routeId: "about",
    });
    const p = layout.placed[0];
    // A 1440×900 window on a 1000px-wide image is 625 image rows.
    expect(p.page?.viewH).toBeCloseTo(625);
    expect(p.h).toBeCloseTo(p.w * 0.625);
  });
});
