import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canCarry,
  carryRoute,
  componentsSought,
  findCarrySource,
  matchesOnly,
  planCarry,
  safeShotFiles,
  verifyCarry,
} from "../src/crawl/carry";
import { markRunIncomplete, runDir } from "../src/crawl/runs";
import type { Device, Manifest, RouteNode, StateNode } from "../src/shared/types";

const devices: Device[] = [
  { name: "desktop", width: 1440, height: 900, dpr: 1 },
  { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true },
];

const shot = (route: string, state: string, device: string) => ({
  full: `screenshots/${route}/${state}/${device}.png`,
  thumb: `screenshots/${route}/${state}/${device}.thumb.webp`,
});

const state = (id: string, extra: Partial<StateNode> = {}): StateNode => ({
  id,
  kind: id === "default" ? "default" : "menu",
  label: id,
  recipe: [],
  shots: {},
  ...extra,
});

/** A route as an earlier run shot it: every state on every device it applies to. */
const shotRoute = (id: string, url: string, states: StateNode[]): RouteNode => ({
  id,
  url,
  depth: 0,
  states: states.map((s) => ({
    ...s,
    shots: Object.fromEntries(
      devices
        .filter((d) => !s.devices || s.devices.includes(d.name))
        .map((d) => [d.name, shot(id, s.id, d.name)]),
    ),
  })),
});

const route = (id: string, url: string, states: StateNode[]): RouteNode => ({
  id,
  url,
  depth: 0,
  states: states.map((s) => ({ ...s, shots: {} })),
});

const manifest = (routes: RouteNode[]): Manifest => ({
  version: 1,
  site: {
    baseUrl: "http://x/",
    origin: "http://x",
    runId: "r1",
    generatedAt: "2026-11-09T00:00:00Z",
  },
  source: { commit: "a".repeat(40), dirty: 0, capturedAt: "2026-11-09T00:00:00Z" },
  devices,
  routes,
});

describe("matching --only", () => {
  it("takes paths and globs", () => {
    expect(matchesOnly({ url: "/about" }, ["/about"])).toBe(true);
    expect(matchesOnly({ url: "/blog/hi" }, ["/blog/**"])).toBe(true);
    expect(matchesOnly({ url: "/blog" }, ["/blog/**"])).toBe(true);
    expect(matchesOnly({ url: "/pricing" }, ["/about"])).toBe(false);
  });
});

describe("canCarry", () => {
  const prev = shotRoute("home", "/", [state("default"), state("menu", { devices: ["mobile"] })]);

  it("carries a route the earlier run shot completely", () => {
    expect(
      canCarry(
        route("home", "/", [state("default"), state("menu", { devices: ["mobile"] })]),
        prev,
        devices,
      ),
    ).toBe(true);
  });

  it("refuses a new route, a new state, a new device and a failed shot", () => {
    expect(canCarry(route("x", "/x", [state("default")]), undefined, devices)).toBe(false);
    expect(canCarry(route("home", "/", [state("default"), state("modal")]), prev, devices)).toBe(
      false,
    );
    // A state that used to be mobile-only now applies everywhere.
    expect(canCarry(route("home", "/", [state("menu")]), prev, devices)).toBe(false);
    const failed = shotRoute("home", "/", [state("default")]);
    failed.states[0].shots.mobile = { error: "timeout" };
    expect(canCarry(route("home", "/", [state("default")]), failed, devices)).toBe(false);
  });

  it("doesn't count a component the earlier run sought and didn't find as a gap", () => {
    const comp = state("component-card", { element: ".card", kind: "component" });
    const sought = new Map([["component-card", ".card"]]);
    expect(canCarry(route("home", "/", [state("default"), comp]), prev, devices, sought)).toBe(
      true,
    );
  });

  it("shoots a component the earlier run never looked for, or looked for elsewhere", () => {
    const comp = state("component-card", { element: ".card", kind: "component" });
    const r = route("home", "/", [state("default"), comp]);
    expect(canCarry(r, prev, devices)).toBe(false);
    expect(canCarry(r, prev, devices, new Map([["component-card", ".old-card"]]))).toBe(false);
  });

  it("reads what the earlier run sought from its config snapshot", () => {
    const m = {
      ...manifest([]),
      configSnapshot: {
        components: [
          { name: "Card", selector: ".card", routes: ["/**"] },
          { name: "Cart", selector: ".cart", routes: ["/shop/**"] },
        ],
      },
    };
    expect([...componentsSought(m, "/about")]).toEqual([["component-card", ".card"]]);
    expect(componentsSought(m, "/shop/x").get("component-cart")).toBe(".cart");
  });
});

describe("planCarry", () => {
  it("shoots --only pages and anything the earlier run can't cover", () => {
    const prev = manifest([
      shotRoute("home", "/", [state("default")]),
      shotRoute("about", "/about", [state("default")]),
      shotRoute("blog", "/blog", [state("default")]),
    ]);
    const plan = planCarry(
      [
        route("home", "/", [state("default")]),
        route("about", "/about", [state("default")]),
        route("blog", "/blog", [state("default"), state("menu")]),
        route("pricing", "/pricing", [state("default")]),
      ],
      ["/about"],
      prev,
      devices,
    );
    expect(plan.capture.map((r) => r.url)).toEqual(["/about", "/blog", "/pricing"]);
    expect(plan.carry.map((r) => r.url)).toEqual(["/"]);
    expect(plan.forced).toEqual([
      { url: "/blog", reason: "incomplete" },
      { url: "/pricing", reason: "new" },
    ]);
  });
});

describe("carrying files", () => {
  let site: string;
  beforeEach(async () => {
    site = await fs.mkdtemp(path.join(os.tmpdir(), "vc-carry-"));
  });
  afterEach(() => fs.rm(site, { recursive: true, force: true }));

  it("finds the newest finished run and copies its shots with their provenance", async () => {
    const earlier = runDir(site, "2026-11-09T00-00-00-000Z");
    const prev = manifest([shotRoute("home", "/", [state("default")])]);
    await fs.mkdir(earlier, { recursive: true });
    await fs.writeFile(path.join(earlier, "crawl-map.json"), JSON.stringify(prev));
    for (const s of Object.values(prev.routes[0].states[0].shots)) {
      for (const f of [s.full!, s.thumb!]) {
        await fs.mkdir(path.dirname(path.join(earlier, f)), { recursive: true });
        await fs.writeFile(path.join(earlier, f), f);
      }
    }
    // An unfinished run after it is skipped.
    const broken = runDir(site, "2026-11-09T01-00-00-000Z");
    await fs.mkdir(broken, { recursive: true });
    await markRunIncomplete(broken);

    const source = await findCarrySource(site, "2026-11-09T02-00-00-000Z");
    expect(source?.runId).toBe("2026-11-09T00-00-00-000Z");

    const now = runDir(site, "2026-11-09T02-00-00-000Z");
    const r = route("home", "/", [state("default")]);
    expect(await carryRoute(r, source!, now, devices)).toBe(2);
    const desk = r.states[0].shots.desktop;
    expect(desk.carried).toEqual({
      runId: "2026-11-09T00-00-00-000Z",
      commit: "a".repeat(40),
      capturedAt: "2026-11-09T00:00:00Z",
    });
    expect(await fs.readFile(path.join(now, desk.full!), "utf8")).toBe(desk.full);
  });

  it("shoots a route instead of carrying it when the earlier run lost a file", async () => {
    const earlier = runDir(site, "2026-11-09T00-00-00-000Z");
    const prev = manifest([
      shotRoute("home", "/", [state("default")]),
      shotRoute("about", "/about", [state("default")]),
    ]);
    await fs.mkdir(earlier, { recursive: true });
    await fs.writeFile(path.join(earlier, "crawl-map.json"), JSON.stringify(prev));
    for (const r of prev.routes) {
      for (const s of Object.values(r.states[0].shots)) {
        for (const f of [s.full!, s.thumb!]) {
          if (r.url === "/about" && f.endsWith("mobile.thumb.webp")) continue; // lost
          await fs.mkdir(path.dirname(path.join(earlier, f)), { recursive: true });
          await fs.writeFile(path.join(earlier, f), f);
        }
      }
    }
    const source = (await findCarrySource(site))!;
    const routes = [
      route("home", "/", [state("default")]),
      route("about", "/about", [state("default")]),
    ];
    const plan = await verifyCarry(planCarry(routes, ["/nothing"], prev, devices), source, devices);
    expect(plan.carry.map((r) => r.url)).toEqual(["/"]);
    expect(plan.capture.map((r) => r.url)).toEqual(["/about"]);
    expect(plan.forced).toEqual([{ url: "/about", reason: "incomplete" }]);

    // And a file gone after the check fails that shot, not the run.
    const about = route("about", "/about", [state("default")]);
    const now = runDir(site, "2026-11-09T02-00-00-000Z");
    expect(await carryRoute(about, source, now, devices)).toBe(1);
    expect(about.states[0].shots.mobile.error).toMatch(/couldn't carry/);
  });
});

describe("--only seeds", () => {
  it("are the plain paths, a full URL reduced to its path", async () => {
    const { onlyPages } = await import("../src/crawl/orchestrator");
    expect(onlyPages(["/about", "/blog/**", "https://site.test/pricing?x=1", "/about"])).toEqual([
      "/about",
      "/pricing?x=1",
    ]);
  });
});

describe("shot paths from an earlier run", () => {
  it("are carried only when they stay inside the run", () => {
    expect(safeShotFiles({ full: "screenshots/home/default/desktop.png" })).toBe(true);
    expect(safeShotFiles({ full: "../../.bashrc" })).toBe(false);
    expect(safeShotFiles({ full: "screenshots/../../x.png" })).toBe(false);
    expect(safeShotFiles({ full: "/etc/passwd" })).toBe(false);
    expect(safeShotFiles({ full: "a.png", thumb: "..\\..\\x.webp" })).toBe(false);
  });
});
