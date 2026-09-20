import { describe, expect, it } from "vitest";
import { readUrlState, serializeUrlState } from "../viewer/src/url-state";

describe("url state", () => {
  it("round-trips a full view", () => {
    const state = {
      mode: "all" as const,
      q: "modal",
      tile: "home__modal__desktop",
      run: "2026-09-20T18-00-46-439Z",
      devices: ["mobile"],
      kinds: ["modal", "menu"],
    };
    expect(readUrlState("?" + serializeUrlState(state))).toEqual(state);
  });

  it("leaves defaults out so a plain link stays plain", () => {
    expect(serializeUrlState({ mode: "grouped" })).toBe("");
    expect(serializeUrlState({})).toBe("");
    expect(serializeUrlState({ devices: [], kinds: [] })).toBe("");
  });

  it("puts the tile last, where it reads as the subject of the link", () => {
    const query = serializeUrlState({ mode: "all", q: "x", tile: "t1" });
    expect(query).toBe("mode=all&q=x&tile=t1");
  });

  it("ignores a mode it doesn't know", () => {
    expect(readUrlState("?mode=sideways").mode).toBeUndefined();
  });

  it("treats empty parameters as absent", () => {
    expect(readUrlState("?q=&devices=&kinds=&tile=")).toEqual({
      mode: undefined,
      q: "",
      tile: undefined,
      run: undefined,
      devices: undefined,
      kinds: undefined,
    });
  });

  it("survives values that need escaping", () => {
    const state = { mode: "grouped" as const, q: "a b&c=d" };
    expect(readUrlState("?" + serializeUrlState(state)).q).toBe("a b&c=d");
  });
});
