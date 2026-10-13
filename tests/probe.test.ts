import { describe, expect, it } from "vitest";
import { addedLines, changedKeys, guessKind } from "../src/crawl/probe";

describe("addedLines", () => {
  it("returns lines that appeared, counting repeats", () => {
    expect(addedLines(["Cart", "Add to cart"], ["Cart", "1", "Add to cart", "Remove"])).toEqual([
      "1",
      "Remove",
    ]);
    // A second "Add to cart" is new even though one was already there.
    expect(addedLines(["Add to cart"], ["Add to cart", "Add to cart"])).toEqual(["Add to cart"]);
    expect(addedLines(["a"], ["a"])).toEqual([]);
  });
});

describe("changedKeys", () => {
  it("lists keys added, removed or changed", () => {
    expect(changedKeys({ a: "1", b: "2", c: "3" }, { a: "1", b: "x", d: "4" })).toEqual([
      "b",
      "c",
      "d",
    ]);
    expect(changedKeys({}, {})).toEqual([]);
  });
});

describe("guessKind", () => {
  const click = [{ action: "click" as const, target: { testId: "go" } }];
  it("trusts an opened region first", () => {
    expect(guessKind("modal", ["Error"], click)).toBe("modal");
  });
  it("reads error-ish text with nothing opened as validation", () => {
    expect(guessKind(null, ["Epic sadface: Username is required"], click)).toBe("validation");
    expect(guessKind(null, ["Remove", "1"], click)).toBe("other");
  });
  it("has no opinion when nothing changed", () => {
    expect(guessKind(null, [], click)).toBeUndefined();
  });
});
