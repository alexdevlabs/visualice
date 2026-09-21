import { describe, expect, it } from "vitest";
import { computeDiffLayout, interestingShots } from "../viewer/src/diff-layout";
import type { RunDiff, ShotDiff } from "../viewer/src/diff-types";

const shot = (over: Partial<ShotDiff> & Pick<ShotDiff, "key" | "status">): ShotDiff => ({
  route: "home",
  routeUrl: "/",
  state: "default",
  stateLabel: "Default",
  device: "desktop",
  fromShot: "screenshots/home/default/desktop.png",
  toShot: "screenshots/home/default/desktop.png",
  ...over,
});

const diff = (shots: ShotDiff[]): RunDiff => ({
  from: { runId: "run-a", dir: "/tmp/a" },
  to: { runId: "run-b", dir: "/tmp/b" },
  minRatio: 0,
  routes: { added: [], removed: [] },
  summary: { added: 0, removed: 0, changed: 0, unchanged: 0, uncomparable: 0 },
  shots,
});

describe("interestingShots", () => {
  it("drops the unchanged pairs, which are most of any diff", () => {
    const d = diff([
      shot({ key: "a", status: "unchanged" }),
      shot({ key: "b", status: "changed", ratio: 0.1 }),
    ]);
    expect(interestingShots(d).map((s) => s.key)).toEqual(["b"]);
  });

  it("keeps them when asked, so 'nothing changed' can be verified", () => {
    const d = diff([shot({ key: "a", status: "unchanged" })]);
    expect(interestingShots(d, true).map((s) => s.key)).toEqual(["a"]);
  });

  it("puts the biggest change first", () => {
    const d = diff([
      shot({ key: "small", status: "changed", ratio: 0.01 }),
      shot({ key: "big", status: "changed", ratio: 0.4 }),
    ]);
    expect(interestingShots(d).map((s) => s.key)).toEqual(["big", "small"]);
  });

  it("ranks changes above appearances and disappearances", () => {
    const d = diff([
      shot({ key: "gone", status: "removed" }),
      shot({ key: "new", status: "added" }),
      shot({ key: "moved", status: "changed", ratio: 0.001 }),
    ]);
    expect(interestingShots(d).map((s) => s.key)).toEqual(["moved", "new", "gone"]);
  });
});

describe("computeDiffLayout", () => {
  const changed = diff([
    shot({
      key: "home|default|desktop",
      status: "changed",
      ratio: 0.031,
      image: "images/home/default/desktop.png",
      fromSize: { width: 1000, height: 2000 },
      toSize: { width: 1000, height: 2000 },
    }),
  ]);

  it("places before, after and diff in one row", () => {
    const l = computeDiffLayout(changed, { diffId: "a__b" });
    expect(l.placed).toHaveLength(3);
    expect(l.placed.map((p) => p.tile.device)).toEqual(["before", "after", "diff"]);
    // One row: same top edge, increasing x.
    expect(new Set(l.placed.map((p) => p.y)).size).toBe(1);
    expect(l.placed[0].x).toBeLessThan(l.placed[1].x);
    expect(l.placed[1].x).toBeLessThan(l.placed[2].x);
  });

  it("points each tile at the directory that actually holds it", () => {
    // The whole reason a diff can't be rendered from one run: the three images live
    // in three places.
    const l = computeDiffLayout(changed, { diffId: "a__b" });
    expect(l.placed[0].tile.full).toBe("runs/run-a/screenshots/home/default/desktop.png");
    expect(l.placed[1].tile.full).toBe("runs/run-b/screenshots/home/default/desktop.png");
    expect(l.placed[2].tile.full).toBe("diffs/a__b/images/home/default/desktop.png");
  });

  it("gives every tile a unique id, so selection and React keys hold", () => {
    const l = computeDiffLayout(changed, { diffId: "a__b" });
    expect(new Set(l.placed.map((p) => p.tile.id)).size).toBe(3);
  });

  it("headlines the row with how much moved", () => {
    const l = computeDiffLayout(changed, { diffId: "a__b" });
    expect(l.labels).toHaveLength(1);
    expect(l.labels[0].title).toContain("/");
    expect(l.labels[0].subtitle).toContain("3.10% of pixels");
  });

  it("says when a page's height changed, not just that pixels did", () => {
    const d = diff([
      shot({
        key: "k",
        status: "changed",
        ratio: 0.5,
        sizeChanged: true,
        fromSize: { width: 1000, height: 2000 },
        toSize: { width: 1000, height: 2600 },
      }),
    ]);
    expect(computeDiffLayout(d, { diffId: "x" }).labels[0].subtitle).toContain(
      "page height changed",
    );
  });

  it("marks the missing side of an added or removed shot in place", () => {
    const d = diff([shot({ key: "k", status: "added", fromShot: undefined })]);
    const l = computeDiffLayout(d, { diffId: "x" });
    expect(l.placed[0].tile.error).toBe("not in this run");
    expect(l.placed[1].tile.error).toBeUndefined();
    expect(l.labels[0].subtitle).toContain("added in the new run");
  });

  it("filters by route, state or device", () => {
    const d = diff([
      shot({ key: "a", status: "changed", route: "home", ratio: 0.1 }),
      shot({ key: "b", status: "changed", route: "about", routeUrl: "/about", ratio: 0.1 }),
    ]);
    expect(computeDiffLayout(d, { diffId: "x", query: "about" }).labels).toHaveLength(1);
    expect(computeDiffLayout(d, { diffId: "x", query: "desktop" }).labels).toHaveLength(2);
  });

  it("lays out nothing, and no stray bounds, for a clean diff", () => {
    const d = diff([shot({ key: "a", status: "unchanged" })]);
    const l = computeDiffLayout(d, { diffId: "x" });
    expect(l.placed).toEqual([]);
    expect(l.bounds).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 });
  });

  it("caps what it places and reports the remainder", () => {
    const d = diff(
      Array.from({ length: 10 }, (_, i) => shot({ key: `k${i}`, status: "changed", ratio: 0.1 })),
    );
    const l = computeDiffLayout(d, { diffId: "x", limit: 4 });
    expect(l.labels).toHaveLength(4);
    expect(l.truncated).toBe(6);
  });
});
