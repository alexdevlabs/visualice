import { describe, it, expect } from "vitest";
import { columnCount, computeLayout } from "../viewer/src/layout";
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
    const l = computeLayout(data, { mode: "grouped", devices: allDevices });
    expect(l.placed).toHaveLength(6);
    expect(l.labels.map((x) => x.routeId)).toEqual(["home", "about"]);
    expect(l.labels[0].subtitle).toContain("2 state(s)");
  });

  it("never overlaps two route sections", () => {
    const l = computeLayout(data, { mode: "grouped", devices: allDevices });
    const home = l.byRoute.get("home")!;
    const about = l.byRoute.get("about")!;
    // Separated on at least one axis — the sections may sit in one column or side
    // by side, but they never sit on top of each other.
    const apart = about.minY >= home.maxY || about.minX >= home.maxX;
    expect(apart).toBe(true);
  });

  it("puts devices side by side, widest device widest on canvas", () => {
    const l = computeLayout(data, { mode: "grouped", devices: allDevices });
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
    const [p] = computeLayout(tall, { mode: "grouped", devices: allDevices }).placed;
    expect(p.cropped).toBe(true);
    expect(p.h).toBeLessThanOrEqual(1120);
  });

  it("skips routes with no matching tiles instead of leaving a gap", () => {
    const l = computeLayout(data, { mode: "grouped", devices: allDevices, query: "about" });
    expect(l.labels.map((x) => x.routeId)).toEqual(["about"]);
    expect(l.placed.every((p) => p.tile.routeId === "about")).toBe(true);
  });
});

describe("computeLayout — filters", () => {
  it("honours the device filter", () => {
    const l = computeLayout(data, { mode: "grouped", devices: new Set(["mobile"]) });
    expect(l.placed).toHaveLength(3);
    expect(l.placed.every((p) => p.tile.device === "mobile")).toBe(true);
  });

  it("searches path, url, state id and label", () => {
    expect(
      computeLayout(data, { mode: "all", devices: allDevices, query: "modal" }).placed,
    ).toHaveLength(2);
    expect(
      computeLayout(data, { mode: "all", devices: allDevices, query: "/about" }).placed,
    ).toHaveLength(2);
    expect(
      computeLayout(data, { mode: "all", devices: allDevices, query: "nothing-here" }).placed,
    ).toHaveLength(0);
  });

  it("returns usable bounds even when everything is filtered out", () => {
    const l = computeLayout(data, { mode: "grouped", devices: allDevices, query: "nothing-here" });
    expect(l.bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  });
});

describe("computeLayout — contact sheet", () => {
  it("packs tiles into rows that wrap", () => {
    const many: ViewerData = {
      ...data,
      tiles: Array.from({ length: 12 }, (_, i) => tile("home", `s${i}`, "desktop")),
    };
    const l = computeLayout(many, { mode: "all", devices: allDevices });
    expect(l.placed).toHaveLength(12);
    expect(new Set(l.placed.map((p) => p.y)).size).toBeGreaterThan(1); // wrapped
    expect(l.labels).toHaveLength(0); // no group headers in contact-sheet mode
  });

  it("keeps every tile inside the reported bounds", () => {
    const l = computeLayout(data, { mode: "all", devices: allDevices });
    for (const p of l.placed) {
      expect(p.x).toBeGreaterThanOrEqual(l.bounds.minX);
      expect(p.y).toBeGreaterThanOrEqual(l.bounds.minY);
      expect(p.x + p.w).toBeLessThanOrEqual(l.bounds.maxX);
      expect(p.y + p.h).toBeLessThanOrEqual(l.bounds.maxY);
    }
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
    const l = computeLayout(manyRoutes, { mode: "grouped", devices: new Set(["desktop"]) });
    const w = l.bounds.maxX - l.bounds.minX;
    const h = l.bounds.maxY - l.bounds.minY;
    expect(l.placed).toHaveLength(20);
    // A single column of 20 tall sections would be far narrower than it is tall.
    expect(w / h).toBeGreaterThan(0.4);
    expect(w / h).toBeLessThan(4);
  });

  it("gives every section its own column slot, never overlapping", () => {
    const l = computeLayout(manyRoutes, { mode: "grouped", devices: new Set(["desktop"]) });
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
    const l = computeLayout(data, { mode: "grouped", devices: allDevices, query: "about" });
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
    const l = computeLayout(withFailure, { mode: "grouped", devices: new Set(["desktop"]) });
    expect(l.placed).toHaveLength(2);
    const failed = l.placed.find((p) => p.tile.error)!;
    expect(failed.w).toBeGreaterThan(0);
    expect(failed.h).toBeGreaterThan(0);
  });

  it("filters by state kind", () => {
    const l = computeLayout(data, {
      mode: "all",
      devices: allDevices,
      kinds: new Set(["modal"]),
    });
    expect(l.placed).toHaveLength(2);
    expect(l.placed.every((p) => p.tile.stateKind === "modal")).toBe(true);
  });

  it("an empty kind filter means all kinds, not none", () => {
    const l = computeLayout(data, { mode: "all", devices: allDevices, kinds: new Set() });
    expect(l.placed).toHaveLength(6);
  });

  it("caps at the limit and reports what it left out", () => {
    const l = computeLayout(data, { mode: "all", devices: allDevices, limit: 4 });
    expect(l.placed).toHaveLength(4);
    expect(l.truncated).toBe(2);
  });

  it("reports nothing truncated when everything fits", () => {
    expect(computeLayout(data, { mode: "all", devices: allDevices, limit: 99 }).truncated).toBe(0);
  });
});

describe("computeLayout — device compare", () => {
  it("lays out one route, every state, at one width per device", () => {
    const l = computeLayout(data, { mode: "devices", devices: allDevices, focusRouteId: "home" });
    // Only the focused route is placed…
    expect(new Set(l.placed.map((p) => p.tile.routeId))).toEqual(new Set(["home"]));
    expect(l.placed).toHaveLength(4);
    // …and both devices get the same card width, which is what makes the two
    // renders comparable by looking straight down the row.
    expect(new Set(l.placed.map((p) => p.w)).size).toBe(1);
  });

  it("puts a state's devices side by side and top-aligned", () => {
    const l = computeLayout(data, { mode: "devices", devices: allDevices, focusRouteId: "home" });
    const row = l.placed.filter((p) => p.tile.stateId === "default");
    expect(row).toHaveLength(2);
    expect(row[0].y).toBe(row[1].y);
    expect(row[0].x).not.toBe(row[1].x);
  });

  it("still offers every route to the sidebar, not just the one on screen", () => {
    const l = computeLayout(data, { mode: "devices", devices: allDevices, focusRouteId: "home" });
    expect(l.routesWithTiles).toEqual(["home", "about"]);
  });

  it("falls back to the first route when the focused one has been filtered away", () => {
    const l = computeLayout(data, {
      mode: "devices",
      devices: allDevices,
      focusRouteId: "about",
      query: "modal", // only `home` has a modal state
    });
    expect(new Set(l.placed.map((p) => p.tile.routeId))).toEqual(new Set(["home"]));
  });

  it("falls back to the first route when none was asked for", () => {
    const l = computeLayout(data, { mode: "devices", devices: allDevices });
    expect(new Set(l.placed.map((p) => p.tile.routeId))).toEqual(new Set(["home"]));
  });

  it("says so rather than going blank when nothing matches", () => {
    const l = computeLayout(data, {
      mode: "devices",
      devices: allDevices,
      query: "nothing-matches-this",
    });
    expect(l.placed).toEqual([]);
    expect(l.routesWithTiles).toEqual([]);
  });
});

describe("computeLayout — routesWithTiles", () => {
  it("lists the routes the filters left, in the data's order", () => {
    const l = computeLayout(data, { mode: "grouped", devices: allDevices });
    expect(l.routesWithTiles).toEqual(["home", "about"]);
    const filtered = computeLayout(data, { mode: "grouped", devices: allDevices, query: "modal" });
    expect(filtered.routesWithTiles).toEqual(["home"]);
  });
});
