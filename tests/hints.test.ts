import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/shared/config";
import { applyHints, describeHints } from "../src/shared/hints";

const base = ConfigSchema.parse({
  stabilize: { maskSelectors: [".clock"], waitForSelectors: [] },
  discovery: { interactions: { denySelectors: [".danger"] } },
});

describe("applyHints", () => {
  it("routes each hint to the knob that implements it", () => {
    const out = applyHints(base, {
      flakyRegions: [".carousel"],
      stableSelectors: ["[data-loaded]"],
      skipTriggers: [".logout"],
    });
    expect(out.stabilize.maskSelectors).toEqual([".clock", ".carousel"]);
    expect(out.stabilize.waitForSelectors).toEqual(["[data-loaded]"]);
    expect(out.discovery.interactions.denySelectors).toEqual([".danger", ".logout"]);
  });

  it("only ever adds — a hint can't drop what the user configured", () => {
    const out = applyHints(base, { flakyRegions: [] });
    expect(out.stabilize.maskSelectors).toContain(".clock");
    expect(out.discovery.interactions.denySelectors).toContain(".danger");
  });

  it("is idempotent, so a re-crawl doesn't stack duplicates", () => {
    const hints = { flakyRegions: [".carousel", ".clock"], skipTriggers: [".logout"] };
    const once = applyHints(base, hints);
    expect(applyHints(once, hints)).toEqual(once);
    expect(once.stabilize.maskSelectors).toEqual([".clock", ".carousel"]);
  });

  it("returns the config untouched when there is nothing to apply", () => {
    expect(applyHints(base, undefined)).toBe(base);
    expect(applyHints(base, { notes: "nothing actionable" })).toBe(base);
  });

  it("leaves the input config alone", () => {
    applyHints(base, { flakyRegions: [".carousel"] });
    expect(base.stabilize.maskSelectors).toEqual([".clock"]);
  });
});

describe("describeHints", () => {
  it("summarizes only what was actually applied", () => {
    expect(describeHints({ flakyRegions: [".a", ".b"] })).toBe(
      "applying site hints: 2 flaky region(s) masked",
    );
    expect(describeHints({ notes: "just a note" })).toBeUndefined();
    expect(describeHints(undefined)).toBeUndefined();
  });
});

describe("generated id hints", () => {
  it("adds learned id patterns to the configured ones", () => {
    const config = ConfigSchema.parse({ discovery: { unstableIds: ["^ember\\d+$"] } });
    const out = applyHints(config, { unstableIds: ["^dlg\\-\\d+$", "^ember\\d+$"] });
    expect(out.discovery.unstableIds).toEqual(["^ember\\d+$", "^dlg\\-\\d+$"]);
    expect(describeHints({ unstableIds: ["^dlg\\-\\d+$"] })).toMatch(/1 generated id pattern/);
  });
});
