import { describe, it, expect } from "vitest";
import { mergeManifests } from "../src/crawl/manifest";
import type { InputManifest, RouteNode, StateNode } from "../src/shared/types";

const state = (id: string, source?: "auto" | "authored"): StateNode => ({
  id,
  kind: "other",
  label: id,
  recipe: [],
  source,
  shots: {},
});

const route = (url: string, states: StateNode[], extra: Partial<RouteNode> = {}): RouteNode => ({
  id: url.replace(/\W+/g, "-"),
  url,
  depth: 0,
  states,
  ...extra,
});

const manifest = (routes: RouteNode[]): InputManifest => ({ routes });

describe("mergeManifests", () => {
  it("keeps the generated-id patterns every run learned", () => {
    const cached = {
      ...manifest([route("/", [])]),
      hints: { unstableIds: ["^a\\d+$"], notes: "x" },
    };
    const fresh = { ...manifest([route("/", [])]), hints: { unstableIds: ["^b\\d+$"] } };
    const merged = mergeManifests(cached, fresh);
    expect(merged.hints?.unstableIds).toEqual(["^a\\d+$", "^b\\d+$"]);
    expect(merged.hints?.notes).toBe("x");
  });

  it("preserves authored states and refreshes auto states on a shared route", () => {
    const cached = manifest([
      route("/", [
        state("default", "authored"),
        state("modal-forge", "authored"),
        state("menu-old", "auto"),
      ]),
    ]);
    const fresh = manifest([route("/", [state("default", "auto"), state("menu-new", "auto")])]);

    const merged = mergeManifests(cached, fresh);
    const ids = merged.routes[0].states.map((s) => s.id);

    // authored kept, stale auto dropped, fresh auto added
    expect(ids).toContain("modal-forge");
    expect(ids).toContain("menu-new");
    expect(ids).not.toContain("menu-old");
  });

  it("authored wins when an auto state collides by id", () => {
    const cached = manifest([route("/", [state("default", "authored")])]);
    const fresh = manifest([route("/", [state("default", "auto")])]);

    const merged = mergeManifests(cached, fresh);
    const def = merged.routes[0].states.filter((s) => s.id === "default");
    expect(def).toHaveLength(1);
    expect(def[0].source).toBe("authored");
  });

  it("treats an untagged cached state as authored (protected by default)", () => {
    const cached = manifest([route("/", [state("legacy")])]); // no source
    const fresh = manifest([route("/", [state("default", "auto")])]);

    const merged = mergeManifests(cached, fresh);
    expect(merged.routes[0].states.map((s) => s.id)).toContain("legacy");
  });

  it("takes fresh route metadata but keeps authored states", () => {
    const cached = manifest([
      route("/", [state("modal-forge", "authored")], { title: "Old", status: 200 }),
    ]);
    const fresh = manifest([route("/", [state("default", "auto")], { title: "New", status: 200 })]);

    const merged = mergeManifests(cached, fresh);
    expect(merged.routes[0].title).toBe("New");
    expect(merged.routes[0].states.map((s) => s.id)).toContain("modal-forge");
  });

  it("unions routes: keeps cached-only routes and adds newly discovered ones", () => {
    const cached = manifest([
      route("/", [state("default", "authored")]),
      route("/authored-only", [state("x", "authored")]),
    ]);
    const fresh = manifest([
      route("/", [state("default", "auto")]),
      route("/new", [state("default", "auto")]),
    ]);

    const merged = mergeManifests(cached, fresh);
    const urls = merged.routes.map((r) => r.url);
    expect(urls).toEqual(["/", "/authored-only", "/new"]);
  });
});
