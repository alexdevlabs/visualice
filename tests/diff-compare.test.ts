import { describe, expect, it } from "vitest";
import type { Manifest, RouteNode, ShotRef, StateNode } from "../src/shared/types";
import { pairShots, routeDelta } from "../src/diff/compare";
import { renderDiffReport } from "../src/diff/report";
import type { RunDiff } from "../src/diff";

const shot = (over: Partial<ShotRef> = {}): ShotRef => ({
  full: "screenshots/x.png",
  width: 100,
  height: 200,
  ...over,
});

const state = (id: string, shots: Record<string, ShotRef>): StateNode => ({
  id,
  kind: "default",
  label: id,
  recipe: [],
  shots,
});

const route = (url: string, states: StateNode[]): RouteNode => ({
  id: url,
  url,
  depth: 0,
  states,
});

const manifest = (routes: RouteNode[], runId = "r1"): Manifest => ({
  version: 1,
  site: {
    baseUrl: "https://x.test",
    origin: "https://x.test",
    runId,
    generatedAt: "2026-09-21T00:00:00.000Z",
  },
  devices: [],
  routes,
});

describe("pairShots", () => {
  it("pairs identical runs as comparable", () => {
    const a = manifest([route("/", [state("default", { desktop: shot() })])]);
    const pairs = pairShots(a, a);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ status: "both", route: "home", state: "default" });
  });

  it("reports one-sided shots as added or removed", () => {
    const before = manifest([route("/", [state("default", { desktop: shot() })])]);
    const after = manifest([
      route("/", [
        state("default", { desktop: shot() }),
        state("modal", { desktop: shot(), mobile: shot() }),
      ]),
      route("/new", [state("default", { desktop: shot() })]),
    ]);

    const byStatus = (s: string) =>
      pairShots(before, after)
        .filter((p) => p.status === s)
        .map((p) => p.key);

    expect(byStatus("both")).toEqual(["home|default|desktop"]);
    expect(byStatus("added")).toEqual([
      "home|modal|desktop",
      "home|modal|mobile",
      "new|default|desktop",
    ]);

    // …and the reverse direction turns the same shots into removals.
    expect(
      pairShots(after, before)
        .filter((p) => p.status === "removed")
        .map((p) => p.key),
    ).toEqual(["home|modal|desktop", "home|modal|mobile", "new|default|desktop"]);
  });

  it("marks a pair uncomparable when either side failed to capture", () => {
    const ok = manifest([route("/", [state("default", { desktop: shot() })])]);
    const broken = manifest([
      route("/", [state("default", { desktop: { error: "timeout exceeded" } })]),
    ]);

    const [pair] = pairShots(ok, broken);
    expect(pair.status).toBe("uncomparable");
    expect(pair.note).toContain("failed in the new run");
    expect(pairShots(broken, ok)[0].note).toContain("failed in the baseline run");
  });

  it("is stable regardless of route/state ordering", () => {
    const a = manifest([
      route("/b", [state("s2", { desktop: shot() })]),
      route("/a", [state("s1", { desktop: shot() })]),
    ]);
    const b = manifest([
      route("/a", [state("s1", { desktop: shot() })]),
      route("/b", [state("s2", { desktop: shot() })]),
    ]);
    expect(pairShots(a, b).map((p) => p.key)).toEqual(["a|s1|desktop", "b|s2|desktop"]);
  });
});

describe("routeDelta", () => {
  it("lists routes that appeared and disappeared", () => {
    const before = manifest([route("/", []), route("/gone", [])]);
    const after = manifest([route("/", []), route("/fresh", [])]);
    expect(routeDelta(before, after)).toEqual({ added: ["fresh"], removed: ["gone"] });
  });
});

describe("renderDiffReport", () => {
  const base: RunDiff = {
    from: { runId: "r1", dir: "/runs/r1" },
    to: { runId: "r2", dir: "/runs/r2" },
    minRatio: 0,
    routes: { added: [], removed: [] },
    summary: { added: 0, removed: 0, changed: 0, unchanged: 3, uncomparable: 0 },
    shots: [],
  };

  it("says so plainly when nothing moved", () => {
    const md = renderDiffReport(base);
    expect(md).toContain("No visual differences.");
    expect(md).not.toContain("## Changed");
  });

  it("puts the biggest change first and links its image", () => {
    const md = renderDiffReport({
      ...base,
      summary: { ...base.summary, changed: 2, unchanged: 1 },
      shots: [
        {
          key: "a",
          route: "home",
          state: "default",
          stateLabel: "Default",
          device: "desktop",
          status: "changed",
          ratio: 0.012,
          image: "images/home/default/desktop.png",
        },
        {
          key: "b",
          route: "about",
          state: "default",
          stateLabel: "Default",
          device: "mobile",
          status: "changed",
          ratio: 0.5,
          sizeChanged: true,
          fromSize: { width: 390, height: 800 },
          toSize: { width: 390, height: 1200 },
          image: "images/about/default/mobile.png",
        },
      ],
    });
    const changed = md.slice(md.indexOf("## Changed"));
    expect(changed.indexOf("about")).toBeLessThan(changed.indexOf("home"));
    expect(changed).toContain("390×800 → 390×1200");
    expect(changed).toContain("[view](images/home/default/desktop.png)");
    expect(changed).toContain("1.2%");
  });

  it("explains uncomparable pairs instead of hiding them", () => {
    const md = renderDiffReport({
      ...base,
      summary: { ...base.summary, uncomparable: 1 },
      shots: [
        {
          key: "a",
          route: "home",
          state: "default",
          stateLabel: "Default",
          device: "desktop",
          status: "uncomparable",
          note: "failed in the new run (timeout)",
        },
      ],
    });
    expect(md).toContain("## Uncomparable");
    expect(md).toContain("failed in the new run (timeout)");
  });
});
