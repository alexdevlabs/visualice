import { describe, expect, it } from "vitest";
import { readUrlState, serializeUrlState } from "../viewer/src/url-state";

describe("url state", () => {
  it("round-trips a full view", () => {
    const state = {
      q: "modal",
      tile: "home__modal__desktop",
      run: "2026-09-20T18-00-46-439Z",
      route: "about",
      devices: ["mobile"],
      kinds: ["modal", "menu"],
    };
    expect(readUrlState("?" + serializeUrlState(state))).toEqual(state);
  });

  it("leaves defaults out so a plain link stays plain", () => {
    expect(serializeUrlState({})).toBe("");
    expect(serializeUrlState({ devices: [], kinds: [] })).toBe("");
  });

  it("puts the tile last, where it reads as the subject of the link", () => {
    const query = serializeUrlState({ q: "x", tile: "t1" });
    expect(query).toBe("q=x&tile=t1");
  });

  it("ignores the retired layout parameters", () => {
    expect(readUrlState("?mode=all&route=home")).not.toHaveProperty("mode");
  });

  it("treats empty parameters as absent", () => {
    expect(readUrlState("?q=&devices=&kinds=&tile=")).toEqual({
      q: "",
      tile: undefined,
      run: undefined,
      devices: undefined,
      kinds: undefined,
    });
  });

  it("survives values that need escaping", () => {
    const state = { q: "a b&c=d" };
    expect(readUrlState("?" + serializeUrlState(state)).q).toBe("a b&c=d");
  });
});
