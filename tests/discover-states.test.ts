import { describe, it, expect } from "vitest";
import { addedRegions } from "../src/crawl/snapshot";

const snap = (...ids: string[]) => ({ ids: [...ids].sort() });

describe("addedRegions", () => {
  it("reports regions that appeared", () => {
    expect(addedRegions(snap(), snap("m:search"))).toEqual(["m:search"]);
    expect(addedRegions(snap("m:search"), snap("m:search", "d:filters"))).toEqual(["d:filters"]);
  });

  it("reports nothing when a click only closes things", () => {
    expect(addedRegions(snap("m:search"), snap())).toEqual([]);
    expect(addedRegions(snap("m:search", "d:filters"), snap("m:search"))).toEqual([]);
  });

  it("reports nothing when the open set is unchanged", () => {
    expect(addedRegions(snap("m:a", "d:b"), snap("m:a", "d:b"))).toEqual([]);
  });

  it("counts identical anonymous regions separately", () => {
    // two unlabelled accordions produce the same key — opening a second one is
    // still a new state, so the diff has to be a multiset difference.
    expect(addedRegions(snap("d:"), snap("d:", "d:"))).toEqual(["d:"]);
    expect(addedRegions(snap("d:", "d:"), snap("d:"))).toEqual([]);
  });

  it("sees a swap (one region replaced by another) as an addition", () => {
    expect(addedRegions(snap("m:login"), snap("m:signup"))).toEqual(["m:signup"]);
  });
});
