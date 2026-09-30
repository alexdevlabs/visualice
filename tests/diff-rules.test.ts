import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/shared/config";
import { ruleMatches, settingsFor } from "../src/diff/rules";
import { renderDiffSummary } from "../src/diff/report";
import type { RunDiff } from "../src/diff";

const rules = (raw: unknown[]) => ConfigSchema.parse({ diff: { rules: raw } }).diff.rules;
const defaults = { threshold: 12, minRatio: 0 };
const shot = (routeUrl: string, state = "default", device = "desktop") => ({
  routeUrl,
  state,
  device,
});

describe("diff rules", () => {
  it("matches on the route's path, not its query or hash", () => {
    const [rule] = rules([{ route: "/blog/**" }]);
    expect(ruleMatches(rule, shot("/blog/post-1?page=2"))).toBe(true);
    expect(ruleMatches(rule, shot("/blog"))).toBe(true);
    expect(ruleMatches(rule, shot("/about"))).toBe(false);
  });

  it("narrows by state (with wildcards) and device", () => {
    const [rule] = rules([{ state: "modal-*", device: "mobile" }]);
    expect(ruleMatches(rule, shot("/", "modal-search", "mobile"))).toBe(true);
    expect(ruleMatches(rule, shot("/", "modal-search", "desktop"))).toBe(false);
    expect(ruleMatches(rule, shot("/", "menu", "mobile"))).toBe(false);
  });

  it("applies every matching rule: later scalars win, ignore regions add up", () => {
    const banner = { x: 0, y: 0, width: 1440, height: 60 };
    const poster = { x: 100, y: 200, width: 300, height: 200 };
    const all = rules([
      { ignore: [banner] },
      { route: "/video/**", threshold: 40, minRatio: 0.01, ignore: [poster] },
      { route: "/video/live", minRatio: 0.05 },
    ]);
    expect(settingsFor(all, defaults, shot("/about"))).toEqual({
      threshold: 12,
      minRatio: 0,
      ignore: [banner],
    });
    expect(settingsFor(all, defaults, shot("/video/live"))).toEqual({
      threshold: 40,
      minRatio: 0.05,
      ignore: [banner, poster],
    });
  });

  it("falls back to the run's settings with no rules at all", () => {
    expect(settingsFor([], { threshold: 3, minRatio: 0.2 }, shot("/"))).toEqual({
      threshold: 3,
      minRatio: 0.2,
      ignore: [],
    });
  });
});

describe("renderDiffSummary", () => {
  const diff = (shots: RunDiff["shots"], baseline = false): RunDiff => ({
    from: { runId: "r1", dir: "/a", ...(baseline ? { baseline: true } : {}) },
    to: { runId: "r2", dir: "/b" },
    minRatio: 0,
    routes: { added: [], removed: [] },
    summary: {
      added: shots.filter((s) => s.status === "added").length,
      removed: 0,
      changed: shots.filter((s) => s.status === "changed").length,
      unchanged: shots.filter((s) => s.status === "unchanged").length,
      uncomparable: 0,
    },
    shots,
  });
  const row = (n: number, status: RunDiff["shots"][number]["status"], ratio?: number) => ({
    key: `p${n}|default|desktop`,
    route: `p${n}`,
    routeUrl: `/p${n}`,
    state: "default",
    stateLabel: "Default",
    device: "desktop",
    status,
    ratio,
    image: "images/x.png",
  });

  it("says so plainly when nothing moved", () => {
    const md = renderDiffSummary(diff([row(1, "unchanged", 0)], true));
    expect(md).toContain("no differences");
    expect(md).toContain("the approved baseline");
    expect(md).not.toContain("| Path |");
  });

  it("lists the loudest rows, caps them, and links no images", () => {
    const shots = Array.from({ length: 25 }, (_, i) => row(i, "changed", (i + 1) / 100));
    const md = renderDiffSummary(diff([...shots, row(99, "added")]), 20);
    expect(md).toContain("26 differences");
    expect(md).toContain("`/p24`");
    expect(md.indexOf("`/p24`")).toBeLessThan(md.indexOf("`/p23`"));
    expect(md).toContain("…and 6 more");
    expect(md).not.toContain("images/x.png");
    expect(md).toContain("against `r1`");
  });
});
