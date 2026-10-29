import { describe, expect, it } from "vitest";
import { keepSiteWideOnce, mergeMobileStates } from "../src/crawl/discover";
import { siteKeyFor } from "../src/crawl/discover-states";
import { mergeManifests } from "../src/crawl/manifest";
import { pagesOnly } from "../src/crawl/orchestrator";
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

describe("siteKeyFor", () => {
  const click = [{ action: "click" as const, target: { text: "Categories" } }];

  it("is the same for the same recipe opening the same text, in any order", () => {
    expect(siteKeyFor(click, ["Hand Tools", "Power Tools"])).toBe(
      siteKeyFor(click, ["Power Tools", "Hand Tools"]),
    );
  });

  it("differs when the same click opens different text", () => {
    expect(siteKeyFor(click, ["Pliers"])).not.toBe(siteKeyFor(click, ["Hammer"]));
  });

  it("is absent when nothing readable appeared", () => {
    expect(siteKeyFor(click, [])).toBeUndefined();
  });
});

describe("keepSiteWideOnce", () => {
  const keyed = (id: string, siteKey?: string, extra: Partial<StateNode> = {}): StateNode => ({
    ...state(id),
    siteKey,
    ...extra,
  });
  const at = (url: string, ...states: StateNode[]): RouteNode => ({
    ...route(...states),
    id: url,
    url,
  });

  it("keeps a site-wide state on the first page only", () => {
    const routes = [
      at("/", keyed("menu-categories", "k1"), keyed("modal-chat", "k2")),
      at("/contact", keyed("menu-categories", "k1"), keyed("focus-form", "k3")),
      at("/privacy", keyed("modal-chat", "k2")),
    ];
    expect(keepSiteWideOnce(routes)).toBe(2);
    expect(routes.map((r) => r.states.map((s) => s.id))).toEqual([
      ["menu-categories", "modal-chat"],
      ["focus-form"],
      [],
    ]);
  });

  it("leaves states without a key, authored states and other device sets alone", () => {
    const routes = [
      at("/", keyed("a", undefined), keyed("menu", "k1")),
      at(
        "/b",
        keyed("a", undefined),
        keyed("menu", "k1", { source: "authored" }),
        keyed("menu-mobile", "k1", { devices: ["mobile"] }),
      ),
    ];
    expect(keepSiteWideOnce(routes)).toBe(0);
    expect(routes[1].states).toHaveLength(3);
  });

  it("drops what already-mapped pages show", () => {
    const routes = [at("/new", keyed("menu", "k1"), keyed("own", "k9"))];
    expect(keepSiteWideOnce(routes, [at("/", keyed("menu", "k1"))])).toBe(1);
    expect(routes[0].states.map((s) => s.id)).toEqual(["own"]);
  });
});

describe("pages-only runs", () => {
  const def = { ...state("default"), kind: "default" as const };
  const model = (...states: StateNode[]) => ({ routes: [{ ...route(...states), title: "old" }] });

  it("keep the cached states a states-free discovery didn't look for", () => {
    const cached = model(def, state("menu-open"), { ...state("drawer"), source: "authored" });
    const fresh = { routes: [{ ...route(def), title: "new" }] };
    const kept = mergeManifests(cached, fresh, { keepStates: true });
    expect(kept.routes[0].states.map((s) => s.id)).toEqual(["default", "menu-open", "drawer"]);
    expect(kept.routes[0].title).toBe("new");
    // A normal merge replaces the auto states with what the fresh pass found.
    expect(mergeManifests(cached, fresh).routes[0].states.map((s) => s.id)).toEqual([
      "drawer",
      "default",
    ]);
  });

  it("capture only each page's default render", () => {
    const only = pagesOnly(model(def, state("menu-open")));
    expect(only.routes[0].states.map((s) => s.id)).toEqual(["default"]);
  });
});
