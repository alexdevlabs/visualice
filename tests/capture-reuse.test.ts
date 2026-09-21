import { describe, expect, it } from "vitest";
import { closingPromises, orderForReuse, reusePlan, type PageState } from "../src/crawl/capture";
import type { RecipeStep, StateNode } from "../src/shared/types";

const click = (id: string): RecipeStep => ({ action: "click", target: { selector: `#${id}` } });
const wait: RecipeStep = { action: "wait", ms: 200 };

const state = (id: string, recipe: RecipeStep[]): StateNode => ({
  id,
  kind: "modal",
  label: id,
  recipe,
  source: "auto",
  shots: {},
});

const shown = (url: string, recipe: RecipeStep[]): PageState => ({ url, recipe });

describe("reusePlan", () => {
  it("reloads when the page has never been used", () => {
    expect(reusePlan({}, "http://x/a", [click("open")])).toBeNull();
  });

  it("reloads when the page is on another route", () => {
    expect(reusePlan(shown("http://x/b", []), "http://x/a", [click("open")])).toBeNull();
  });

  it("runs the whole recipe on a page still showing the default render", () => {
    // The common case, and the one page reuse was always supposed to pay for: the
    // default shot leaves the page exactly where every other recipe starts.
    expect(reusePlan(shown("http://x/a", []), "http://x/a", [click("open"), wait])).toEqual([
      click("open"),
      wait,
    ]);
  });

  it("runs only the extra steps of a nested state", () => {
    expect(
      reusePlan(shown("http://x/a", [click("open")]), "http://x/a", [
        click("open"),
        click("filters"),
      ]),
    ).toEqual([click("filters")]);
  });

  it("reloads when the recipe diverges rather than extends", () => {
    expect(
      reusePlan(shown("http://x/a", [click("open")]), "http://x/a", [click("other")]),
    ).toBeNull();
    expect(
      reusePlan(shown("http://x/a", [click("open"), click("a")]), "http://x/a", [
        click("open"),
        click("b"),
      ]),
    ).toBeNull();
  });

  it("reloads rather than reuse a page already at the same state", () => {
    // Nothing would be left to apply, and the shot is supposed to be taken from a
    // page that reached the state, not one that is merely still sitting in it.
    expect(
      reusePlan(shown("http://x/a", [click("open")]), "http://x/a", [click("open")]),
    ).toBeNull();
  });

  it("reloads when the page shows more than the recipe asks for", () => {
    expect(
      reusePlan(shown("http://x/a", [click("open"), click("deep")]), "http://x/a", [click("open")]),
    ).toBeNull();
  });

  it("compares steps by value, not identity", () => {
    expect(
      reusePlan(
        shown("http://x/a", [{ action: "click", target: { selector: "#open" } }]),
        "http://x/a",
        [{ action: "click", target: { selector: "#open" } }, wait],
      ),
    ).toEqual([wait]);
  });
});

describe("orderForReuse", () => {
  it("leaves a flat route alone — there is nothing to gain", () => {
    const states = [
      state("default", []),
      state("modal-search", [click("search")]),
      state("menu-nav", [click("nav")]),
    ];
    expect(orderForReuse(states).map((s) => s.id)).toEqual(["default", "modal-search", "menu-nav"]);
  });

  it("keeps the default render first, so everything else can extend it", () => {
    const states = [state("modal-search", [click("search")]), state("default", [])];
    expect(orderForReuse(states)[0].id).toBe("default");
  });

  it("puts a nested state straight after the parent it extends", () => {
    // Discovery emits states depth by depth, so the children of the first state sit
    // behind every other top-level state in manifest order.
    const states = [
      state("default", []),
      state("modal-a", [click("a")]),
      state("modal-b", [click("b")]),
      state("modal-a-tab", [click("a"), click("tab")]),
      state("modal-b-tab", [click("b"), click("tab")]),
    ];
    expect(orderForReuse(states).map((s) => s.id)).toEqual([
      "default",
      "modal-a",
      "modal-a-tab",
      "modal-b",
      "modal-b-tab",
    ]);
  });

  it("follows a chain as deep as it goes", () => {
    const states = [
      state("default", []),
      state("a", [click("a")]),
      state("a-b-c", [click("a"), click("b"), click("c")]),
      state("a-b", [click("a"), click("b")]),
    ];
    expect(orderForReuse(states).map((s) => s.id)).toEqual(["default", "a", "a-b", "a-b-c"]);
  });

  it("returns every state exactly once", () => {
    const states = [
      state("default", []),
      state("a", [click("a")]),
      state("a-b", [click("a"), click("b")]),
      state("c", [click("c")]),
    ];
    const ordered = orderForReuse(states);
    expect(ordered).toHaveLength(states.length);
    expect(new Set(ordered.map((s) => s.id)).size).toBe(states.length);
  });

  it("handles a route with no states at all", () => {
    expect(orderForReuse([])).toEqual([]);
  });
});

describe("closingPromises", () => {
  const open = click("a");
  const waitA = { action: "waitFor", selector: "#panel-a", state: "visible" } as const;
  const waitB = { action: "waitFor", selector: "#panel-b", state: "visible" } as const;

  it("is what the recipe waits for after its last interaction", () => {
    expect(closingPromises([open, waitA])).toEqual([waitA]);
    expect(closingPromises([open, waitA, wait, waitB])).toEqual([waitA, waitB]);
  });

  it("ignores what an earlier step waited for — later steps may have moved on", () => {
    expect(closingPromises([open, waitA, open])).toEqual([]);
    expect(closingPromises([open, waitA, open, waitB])).toEqual([waitB]);
  });

  it("has nothing to check for a recipe that promises nothing", () => {
    expect(closingPromises([])).toEqual([]);
    expect(closingPromises([open, wait])).toEqual([]);
    expect(closingPromises([open, { action: "waitFor", url: "**/done" }])).toEqual([]);
  });
});
