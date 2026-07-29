import { describe, expect, it } from "vitest";
import { mergeMobileStates } from "../src/crawl/discover";
import type { RouteNode, StateNode } from "../src/shared/types";

const state = (id: string, signature?: string): StateNode => ({
  id,
  kind: "menu",
  label: id,
  recipe: [],
  signature,
  source: "auto",
  shots: {},
});

const route = (...states: StateNode[]): RouteNode => ({
  id: "home",
  url: "/",
  depth: 0,
  states,
});

describe("mergeMobileStates", () => {
  it("adds mobile-only states restricted to the mobile devices", () => {
    const r = route(state("default", "base"), state("menu-open", "sig-a"));
    mergeMobileStates(
      r,
      [state("default", "base-m"), state("menu-hamburger", "sig-b")],
      ["mobile", "tablet"],
    );
    expect(r.states.map((s) => s.id)).toEqual(["default", "menu-open", "menu-hamburger"]);
    expect(r.states[2].devices).toEqual(["mobile", "tablet"]);
    expect(r.states[0].devices).toBeUndefined();
  });

  it("drops mobile states whose signature the desktop pass already found", () => {
    const r = route(state("default", "base"), state("menu-open", "sig-a"));
    mergeMobileStates(r, [state("default", "base"), state("menu-nav", "sig-a")], ["mobile"]);
    expect(r.states).toHaveLength(2);
  });

  it("uniquifies colliding ids from the mobile pass", () => {
    const r = route(state("default", "base"), state("menu-open", "sig-a"));
    mergeMobileStates(r, [state("menu-open", "sig-different")], ["mobile"]);
    expect(r.states.map((s) => s.id)).toEqual(["default", "menu-open", "menu-open-2"]);
  });

  it("never duplicates the default state", () => {
    const r = route(state("default", "base"));
    mergeMobileStates(r, [state("default", "totally-different")], ["mobile"]);
    expect(r.states).toHaveLength(1);
  });
});
