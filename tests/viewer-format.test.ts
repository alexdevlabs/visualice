import { describe, expect, it } from "vitest";
import { heightDelta, percent, runLabel } from "../viewer/src/format";

describe("runLabel", () => {
  it("reads a generated run id as a short date", () => {
    expect(runLabel("2026-09-21T01-49-07-123Z")).toBe("Sep 21, 01:49");
  });

  it("leaves a hand-named run alone", () => {
    expect(runLabel("baseline")).toBe("baseline");
  });
});

describe("percent", () => {
  it("shows two decimals, and a dash when there is no ratio", () => {
    expect(percent(0.059)).toBe("5.90%");
    expect(percent(undefined)).toBe("—");
  });
});

describe("heightDelta", () => {
  it("signs the change and drops the unchanged case", () => {
    expect(heightDelta({ height: 1478 }, { height: 1518 })).toBe("+40px");
    expect(heightDelta({ height: 900 }, { height: 888 })).toBe("−12px");
    expect(heightDelta({ height: 900 }, { height: 900 })).toBeUndefined();
    expect(heightDelta(undefined, { height: 900 })).toBeUndefined();
  });
});
