import { describe, it, expect } from "vitest";
import { computeLayout } from "../viewer/src/layout";
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
    const l = computeLayout(data, "grouped", allDevices, "");
    expect(l.placed).toHaveLength(6);
    expect(l.labels.map((x) => x.routeId)).toEqual(["home", "about"]);
    expect(l.labels[0].subtitle).toContain("2 state(s)");
  });

  it("stacks routes vertically without overlapping", () => {
    const l = computeLayout(data, "grouped", allDevices, "");
    const home = l.byRoute.get("home")!;
    const about = l.byRoute.get("about")!;
    expect(about.minY).toBeGreaterThanOrEqual(home.maxY);
  });

  it("puts devices side by side, widest device widest on canvas", () => {
    const l = computeLayout(data, "grouped", allDevices, "");
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
    const [p] = computeLayout(tall, "grouped", allDevices, "").placed;
    expect(p.cropped).toBe(true);
    expect(p.h).toBeLessThanOrEqual(1120);
  });

  it("skips routes with no matching tiles instead of leaving a gap", () => {
    const l = computeLayout(data, "grouped", allDevices, "about");
    expect(l.labels.map((x) => x.routeId)).toEqual(["about"]);
    expect(l.placed.every((p) => p.tile.routeId === "about")).toBe(true);
  });
});

describe("computeLayout — filters", () => {
  it("honours the device filter", () => {
    const l = computeLayout(data, "grouped", new Set(["mobile"]), "");
    expect(l.placed).toHaveLength(3);
    expect(l.placed.every((p) => p.tile.device === "mobile")).toBe(true);
  });

  it("searches path, url, state id and label", () => {
    expect(computeLayout(data, "all", allDevices, "modal").placed).toHaveLength(2);
    expect(computeLayout(data, "all", allDevices, "/about").placed).toHaveLength(2);
    expect(computeLayout(data, "all", allDevices, "nothing-here").placed).toHaveLength(0);
  });

  it("returns usable bounds even when everything is filtered out", () => {
    const l = computeLayout(data, "grouped", allDevices, "nothing-here");
    expect(l.bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  });
});

describe("computeLayout — contact sheet", () => {
  it("packs tiles into rows that wrap", () => {
    const many: ViewerData = {
      ...data,
      tiles: Array.from({ length: 12 }, (_, i) => tile("home", `s${i}`, "desktop")),
    };
    const l = computeLayout(many, "all", allDevices, "");
    expect(l.placed).toHaveLength(12);
    expect(new Set(l.placed.map((p) => p.y)).size).toBeGreaterThan(1); // wrapped
    expect(l.labels).toHaveLength(0); // no group headers in contact-sheet mode
  });

  it("keeps every tile inside the reported bounds", () => {
    const l = computeLayout(data, "all", allDevices, "");
    for (const p of l.placed) {
      expect(p.x).toBeGreaterThanOrEqual(l.bounds.minX);
      expect(p.y).toBeGreaterThanOrEqual(l.bounds.minY);
      expect(p.x + p.w).toBeLessThanOrEqual(l.bounds.maxX);
      expect(p.y + p.h).toBeLessThanOrEqual(l.bounds.maxY);
    }
  });
});
