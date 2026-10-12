import { describe, expect, it } from "vitest";
import { runLabel } from "../viewer/src/format";

describe("runLabel", () => {
  it("reads a generated run id as a short date", () => {
    expect(runLabel("2026-09-21T01-49-07-123Z")).toBe("Sep 21, 01:49");
  });

  it("leaves a hand-named run alone", () => {
    expect(runLabel("baseline")).toBe("baseline");
  });
});
